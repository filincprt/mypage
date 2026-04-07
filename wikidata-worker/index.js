export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const allowOrigin = env.ALLOWED_ORIGIN || origin || '*';

    const headers = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Content-Type': 'application/json; charset=utf-8',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
        status: 405,
        headers,
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '');
    const language = (url.searchParams.get('language') || 'ru').toLowerCase();

    try {
      if (pathname.endsWith('/search')) {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) {
          return new Response(JSON.stringify({ ok: true, results: [] }), { headers });
        }

        const [ru, en] = await Promise.all([
          searchEntities(q, 'ru'),
          language === 'ru' ? searchEntities(q, 'en') : Promise.resolve([]),
        ]);

        const merged = dedupeById([...ru, ...en]);
        const enriched = await enrichBatch(merged.slice(0, 12), language);

        return new Response(JSON.stringify({ ok: true, results: enriched }), { headers });
      }

      if (pathname.endsWith('/details')) {
        const qid = (url.searchParams.get('id') || '').trim();
        if (!qid) {
          return new Response(JSON.stringify({ ok: false, error: 'Missing id' }), {
            status: 400,
            headers,
          });
        }

        const [item] = await enrichBatch([{ id: qid }], language, true);
        if (!item) {
          return new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
            status: 404,
            headers,
          });
        }

        return new Response(JSON.stringify({ ok: true, details: item }), { headers });
      }

      return new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
        status: 404,
        headers,
      });
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: error?.message || 'Unknown error' }), {
        status: 500,
        headers,
      });
    }
  },
};

async function searchEntities(q, language) {
  const endpoint = new URL('https://www.wikidata.org/w/api.php');
  endpoint.searchParams.set('action', 'wbsearchentities');
  endpoint.searchParams.set('search', q);
  endpoint.searchParams.set('language', language);
  endpoint.searchParams.set('uselang', language);
  endpoint.searchParams.set('type', 'item');
  endpoint.searchParams.set('limit', '10');
  endpoint.searchParams.set('format', 'json');

  const data = await fetchJson(endpoint.toString());
  return (data.search || []).map((item) => ({
    id: item.id,
    label: item.label || '',
    description: item.description || '',
  }));
}

async function enrichBatch(items, language, onlySingle = false) {
  const ids = items.map((i) => i.id).filter(Boolean);
  if (!ids.length) return [];

  const endpoint = new URL('https://www.wikidata.org/w/api.php');
  endpoint.searchParams.set('action', 'wbgetentities');
  endpoint.searchParams.set('ids', ids.join('|'));
  endpoint.searchParams.set('languages', `${language}|en`);
  endpoint.searchParams.set('props', 'labels|descriptions|claims');
  endpoint.searchParams.set('format', 'json');

  const data = await fetchJson(endpoint.toString());
  const entities = data.entities || {};

  const castIds = new Set();
  for (const id of ids) {
    const entity = entities[id];
    if (!entity) continue;
    const claims = entity.claims || {};
    for (const claim of claims.P161 || []) {
      const castId = claim?.mainsnak?.datavalue?.value?.id;
      if (castId) castIds.add(castId);
    }
  }

  const castLabels = castIds.size ? await fetchLabels([...castIds], language) : {};

  return ids.map((id) => normalizeEntity(entities[id], castLabels, language)).filter(Boolean);
}

async function fetchLabels(ids, language) {
  const endpoint = new URL('https://www.wikidata.org/w/api.php');
  endpoint.searchParams.set('action', 'wbgetentities');
  endpoint.searchParams.set('ids', ids.join('|'));
  endpoint.searchParams.set('languages', `${language}|en`);
  endpoint.searchParams.set('props', 'labels');
  endpoint.searchParams.set('format', 'json');

  const data = await fetchJson(endpoint.toString());
  const entities = data.entities || {};
  const result = {};
  for (const [id, entity] of Object.entries(entities)) {
    result[id] = pickLabel(entity?.labels, language) || id;
  }
  return result;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'filin-cprt-catalog/1.0 (Cloudflare Worker)',
    },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON from Wikidata: ${text.slice(0, 180)}`);
  }
  if (!res.ok) {
    const msg = data?.error?.info || data?.errors?.[0]?.text || `Wikidata error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function dedupeById(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function getClaimIds(entity, prop) {
  return (entity?.claims?.[prop] || [])
    .map((claim) => claim?.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
}

function getClaimTimeYear(entity, prop) {
  const claim = (entity?.claims?.[prop] || [])[0];
  const time = claim?.mainsnak?.datavalue?.value?.time;
  if (!time) return '';
  const match = String(time).match(/^([+-]\d{4})/);
  return match ? match[1].replace('+', '') : String(time).slice(1, 5);
}

function pickLabel(labels, language) {
  return labels?.[language]?.value || labels?.en?.value || labels?.ru?.value || '';
}

function pickDescription(descriptions, language) {
  return descriptions?.[language]?.value || descriptions?.en?.value || descriptions?.ru?.value || '';
}

function normalizeEntity(entity, castLabels, language) {
  if (!entity) return null;

  const qid = entity.id;
  const labels = entity.labels || {};
  const descriptions = entity.descriptions || {};
  const title = pickLabel(labels, language) || qid;
  const description = pickDescription(descriptions, language);
  const posterFile = getClaimIds(entity, 'P18')[0] || '';
  const genreIds = getClaimIds(entity, 'P136');
  const countryIds = getClaimIds(entity, 'P495');
  const castIds = getClaimIds(entity, 'P161');
  const inceptionYear = getClaimTimeYear(entity, 'P571');
  const releaseYear = getClaimTimeYear(entity, 'P577');

  const typeIds = getClaimIds(entity, 'P31');
  const isMovie = typeIds.includes('Q11424');
  const isTv = typeIds.includes('Q5398426');

  const type = isMovie ? 'movie' : isTv ? 'tv' : 'item';
  const year = releaseYear || inceptionYear || '—';

  return {
    id: qid,
    media_type: type,
    title,
    description,
    year,
    poster_path: posterFile ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(posterFile)}` : '',
    genres: genreIds.map((id) => castLabels[id] || id),
    countries: countryIds.map((id) => castLabels[id] || id),
    cast: castIds.slice(0, 10).map((id) => castLabels[id] || id),
    wikidataUrl: `https://www.wikidata.org/wiki/${qid}`,
  };
}
