export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const allowOrigin = env.ALLOWED_ORIGIN || origin || '*';
    const headers = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Content-Type': 'application/json; charset=utf-8',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path.endsWith('/search') && request.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        const type = (url.searchParams.get('type') || 'all').trim();
        if (!q) return json({ ok: true, results: [] }, headers);
        const results = await searchLookup(q, type);
        return json({ ok: true, results }, headers);
      }

      if (path.endsWith('/public') && request.method === 'GET') {
        const rows = await env.DB.prepare(
          `SELECT * FROM entries WHERE is_public = 1 ORDER BY COALESCE(watched_at, updated_at) DESC, id DESC`
        ).all();
        return json({ ok: true, results: rows.results.map(rowToEntry) }, headers);
      }

      if (path.endsWith('/admin')) {
        requireAuth(request, env);

        if (request.method === 'GET') {
          const rows = await env.DB.prepare(
            `SELECT * FROM entries ORDER BY COALESCE(watched_at, updated_at) DESC, id DESC`
          ).all();
          return json({ ok: true, results: rows.results.map(rowToEntry) }, headers);
        }

        if (request.method === 'POST') {
          const body = await request.json();
          const entry = normalizeIncoming(body);
          await upsertEntry(env, entry);
          return json({ ok: true }, headers);
        }

        if (request.method === 'DELETE') {
          const body = await request.json().catch(() => ({}));
          if (!body.id) return json({ ok: false, error: 'Missing id' }, headers, 400);
          await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(String(body.id)).run();
          return json({ ok: true }, headers);
        }

        return json({ ok: false, error: 'Method not allowed' }, headers, 405);
      }

      return json({ ok: false, error: 'Not found' }, headers, 404);
    } catch (error) {
      return json({ ok: false, error: error?.message || 'Unknown error' }, headers, 500);
    }
  },
};

function json(payload, headers, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers });
}

function requireAuth(request, env) {
  const password = env.ADMIN_PASSWORD;
  if (!password) throw new Error('Missing ADMIN_PASSWORD');

  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Basic ')) {
    throw unauthorized();
  }

  const decoded = atob(auth.slice(6));
  const sep = decoded.indexOf(':');
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  if (user !== 'admin' || pass !== password) {
    throw unauthorized();
  }
}

function unauthorized() {
  const err = new Error('Unauthorized');
  err.status = 401;
  return err;
}

function normalizeIncoming(body) {
  const id = String(body.id || `manual_${Date.now()}`);
  return {
    id,
    source: String(body.source || 'manual'),
    source_id: String(body.source_id || ''),
    media_type: String(body.media_type || 'movie'),
    title: String(body.title || '').trim(),
    original_title: String(body.original_title || '').trim(),
    year: String(body.year || '').trim(),
    poster_url: String(body.poster_url || '').trim(),
    description: String(body.description || '').trim(),
    cast_json: JSON.stringify(Array.isArray(body.cast) ? body.cast : []),
    genres_json: JSON.stringify(Array.isArray(body.genres) ? body.genres : []),
    countries_json: JSON.stringify(Array.isArray(body.countries) ? body.countries : []),
    rating: body.rating ?? null,
    favorite: body.favorite ? 1 : 0,
    comment: String(body.comment || '').trim(),
    is_public: body.is_public ? 1 : 0,
    watched_at: String(body.watched_at || '').trim() || null,
    updated_at: new Date().toISOString(),
  };
}

async function upsertEntry(env, entry) {
  const stmt = env.DB.prepare(`
    INSERT INTO entries (
      id, source, source_id, media_type, title, original_title, year,
      poster_url, description, cast_json, genres_json, countries_json,
      rating, favorite, comment, is_public, watched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source=excluded.source,
      source_id=excluded.source_id,
      media_type=excluded.media_type,
      title=excluded.title,
      original_title=excluded.original_title,
      year=excluded.year,
      poster_url=excluded.poster_url,
      description=excluded.description,
      cast_json=excluded.cast_json,
      genres_json=excluded.genres_json,
      countries_json=excluded.countries_json,
      rating=excluded.rating,
      favorite=excluded.favorite,
      comment=excluded.comment,
      is_public=excluded.is_public,
      watched_at=excluded.watched_at,
      updated_at=excluded.updated_at
  `);

  await stmt.bind(
    entry.id,
    entry.source,
    entry.source_id,
    entry.media_type,
    entry.title,
    entry.original_title,
    entry.year,
    entry.poster_url,
    entry.description,
    entry.cast_json,
    entry.genres_json,
    entry.countries_json,
    entry.rating,
    entry.favorite,
    entry.comment,
    entry.is_public,
    entry.watched_at,
    entry.updated_at,
  ).run();
}

function rowToEntry(row) {
  return {
    id: row.id,
    source: row.source,
    source_id: row.source_id,
    media_type: row.media_type,
    title: row.title,
    original_title: row.original_title,
    year: row.year,
    poster_url: row.poster_url,
    description: row.description,
    cast: safeJson(row.cast_json, []),
    genres: safeJson(row.genres_json, []),
    countries: safeJson(row.countries_json, []),
    rating: row.rating,
    favorite: Boolean(row.favorite),
    comment: row.comment,
    is_public: Boolean(row.is_public),
    watched_at: row.watched_at,
    updated_at: row.updated_at,
  };
}

function safeJson(str, fallback) {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch {
    return fallback;
  }
}

async function searchLookup(q, type) {
  const items = [];
  const wantMovies = type === 'all' || type === 'movie';
  const wantTv = type === 'all' || type === 'tv';

  if (wantMovies) {
    items.push(...await searchWikidata(q, 'movie'));
  }
  if (wantTv) {
    items.push(...await searchWikidata(q, 'tv'));
    items.push(...await searchTvMaze(q));
  }

  const deduped = [];
  const seen = new Set();
  for (const item of items) {
    const key = `${item.source}:${item.source_id || item.id || item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.slice(0, 20);
}

async function searchWikidata(q, type) {
  const endpoints = [
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=ru&uselang=ru&type=item&limit=10&format=json`,
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&uselang=en&type=item&limit=10&format=json`,
  ];

  const results = [];
  for (const endpoint of endpoints) {
    const data = await fetchJson(endpoint);
    for (const item of data.search || []) {
      results.push({
        source: 'wikidata',
        source_id: item.id,
        media_type: type,
        title: item.label || item.id,
        original_title: item.label || item.id,
        year: '',
        poster_url: '',
        description: item.description || '',
        cast: [],
        genres: [],
        countries: [],
      });
    }
  }
  return results;
}

async function searchTvMaze(q) {
  const data = await fetchJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`);
  return (data || []).map((hit) => {
    const s = hit.show || {};
    return {
      source: 'tvmaze',
      source_id: String(s.id || ''),
      media_type: 'tv',
      title: s.name || 'Без названия',
      original_title: s.name || 'Без названия',
      year: s.premiered ? String(s.premiered).slice(0, 4) : '',
      poster_url: s.image?.original || s.image?.medium || '',
      description: stripHtml(s.summary || ''),
      cast: [],
      genres: Array.isArray(s.genres) ? s.genres : [],
      countries: s.network?.country?.code ? [s.network.country.code] : [],
    };
  });
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
