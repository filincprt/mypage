export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors(env, request) });
    }

    try {
      if (path === '/catalog' && request.method === 'GET') {
        return serveAsset(request, env, '/catalog.html');
      }

      if (path === '/admin.html' && request.method === 'GET') {
        const user = checkAuth(request, env);
        if (!user) return unauthorized(env, request);
        return serveAsset(request, env, '/admin.html');
      }

      if (path === '/search') {
        const q = url.searchParams.get('q') || '';
        const type = url.searchParams.get('type') || 'all';
        const language = url.searchParams.get('language') || 'ru-RU';
        const results = await searchTMDB(env, q, type, language);
        return json({ ok: true, data: { results }, results }, env, request);
      }

      if (path === '/details') {
        const id = url.searchParams.get('id');
        const type = url.searchParams.get('type');
        const language = url.searchParams.get('language') || 'ru-RU';
        const data = await detailsTMDB(env, id, type, language);
        return json({ ok: true, data, ...data }, env, request);
      }

      if (path === '/public') {
        const type = url.searchParams.get('type') || 'all';
        const genre = (url.searchParams.get('genre') || '').trim();
        const sort = url.searchParams.get('sort') || 'created_desc';

        const rows = await env.DB.prepare('SELECT * FROM entries WHERE is_public = 1').all();
        let results = (rows.results || []).map(normalizeRow);

        if (type === 'movie' || type === 'tv') {
          results = results.filter((item) => item.media_type === type);
        }

        if (genre && genre !== 'all') {
          const wanted = genre.toLowerCase();
          results = results.filter((item) => {
            const list = Array.isArray(item.genres) ? item.genres : [];
            return list.some((g) => String(g?.name || '').toLowerCase() === wanted);
          });
        }

        results = sortPublic(results, sort);

        return json({ ok: true, data: { results }, results }, env, request);
      }

      if (path === '/public/genres' && request.method === 'GET') {
        const rows = await env.DB.prepare('SELECT genres_json FROM entries WHERE is_public = 1').all();
        const set = new Set();

        for (const row of rows.results || []) {
          const genres = parseArray(row.genres_json);
          for (const g of genres) {
            const name = String(g?.name || '').trim();
            if (name) set.add(name);
          }
        }

        const genres = Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'));
        return json({ ok: true, data: { genres }, genres }, env, request);
      }

      if (path === '/admin') {
        const user = checkAuth(request, env);
        if (!user) return unauthorized(env, request);

        if (request.method === 'GET' && wantsHtml(request)) {
          return serveAsset(request, env, '/admin.html');
        }

        if (request.method === 'GET') {
          const rows = await env.DB.prepare('SELECT * FROM entries ORDER BY created_at DESC').all();
          const results = (rows.results || []).map(normalizeRow);
          return json({ ok: true, data: { results }, results }, env, request);
        }

        if (request.method === 'POST') {
          const body = await safeJson(request);
          const id = body.id || crypto.randomUUID();

          const payload = normalizeInsertPayload(body, id);

          await env.DB.prepare(`INSERT OR REPLACE INTO entries (
            id, source, source_id, media_type, title, original_title, year,
            poster_path, overview, cast_json, genres_json, countries_json,
            rating, favorite, comment, is_public, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
            payload.id,
            payload.source,
            payload.source_id,
            payload.media_type,
            payload.title,
            payload.original_title,
            payload.year,
            payload.poster_path,
            payload.overview,
            payload.cast_json,
            payload.genres_json,
            payload.countries_json,
            payload.rating,
            payload.favorite,
            payload.comment,
            payload.is_public,
            payload.created_at
          ).run();

          return json({ ok: true, data: { id }, id }, env, request);
        }

        if (request.method === 'PATCH') {
          const body = await safeJson(request);
          const id = body.id;
          if (!id) {
            return json({ ok: false, error: 'id is required' }, env, request, 400);
          }

          const update = buildPatch(body);
          if (!update.fields.length) {
            return json({ ok: false, error: 'No fields to update' }, env, request, 400);
          }

          await env.DB.prepare(
            `UPDATE entries SET ${update.fields.join(', ')} WHERE id = ?`
          ).bind(...update.bindings, id).run();

          return json({ ok: true, data: { id } }, env, request);
        }

        if (request.method === 'DELETE') {
          const body = await safeJson(request);
          if (!body.id) {
            return json({ ok: false, error: 'id is required' }, env, request, 400);
          }
          await env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(body.id).run();
          return json({ ok: true, data: { id: body.id } }, env, request);
        }

        return json({ ok: false, error: 'Method not allowed' }, env, request, 405);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return json({ ok: false, error: err.message || 'Unknown error' }, env, request, 500);
    }
  }
};

function normalizePath(pathname) {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function wantsHtml(request) {
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/html') && !accept.includes('application/json');
}

function sortPublic(rows, sort) {
  const list = [...rows];

  if (sort === 'created_asc') {
    return list.sort((a, b) => safeDate(a.created_at) - safeDate(b.created_at));
  }

  if (sort === 'rating_desc') {
    return list.sort((a, b) => safeNumber(b.rating) - safeNumber(a.rating));
  }

  if (sort === 'rating_asc') {
    return list.sort((a, b) => safeNumber(a.rating) - safeNumber(b.rating));
  }

  return list.sort((a, b) => safeDate(b.created_at) - safeDate(a.created_at));
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeDate(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeRow(row) {
  return {
    ...row,
    cast: parseArray(row.cast_json),
    genres: parseArray(row.genres_json),
    countries: parseArray(row.countries_json)
  };
}

function safeJson(request) {
  return request.json().catch(() => ({}));
}

function toDbBool(value) {
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    return lower === '1' || lower === 'true' || lower === 'yes' ? 1 : 0;
  }
  return value ? 1 : 0;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeInsertPayload(body, id) {
  const cast = Array.isArray(body.cast) ? body.cast : parseArray(body.cast_json);
  const genres = Array.isArray(body.genres) ? body.genres : parseArray(body.genres_json);
  const countries = Array.isArray(body.countries) ? body.countries : parseArray(body.countries_json);

  return {
    id,
    source: body.source || 'tmdb',
    source_id: body.source_id || '',
    media_type: body.media_type || 'movie',
    title: body.title || '',
    original_title: body.original_title || '',
    year: body.year || null,
    poster_path: body.poster_path || '',
    overview: body.overview || '',
    cast_json: JSON.stringify(cast),
    genres_json: JSON.stringify(genres),
    countries_json: JSON.stringify(countries),
    rating: toNullableNumber(body.rating),
    favorite: toDbBool(body.favorite),
    comment: body.comment || '',
    is_public: toDbBool(body.is_public),
    created_at: body.created_at || new Date().toISOString()
  };
}

function buildPatch(body) {
  const fields = [];
  const bindings = [];

  const set = (column, value) => {
    fields.push(`${column} = ?`);
    bindings.push(value);
  };

  if (Object.prototype.hasOwnProperty.call(body, 'rating')) {
    set('rating', toNullableNumber(body.rating));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'favorite')) {
    set('favorite', toDbBool(body.favorite));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'comment')) {
    set('comment', body.comment || '');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'is_public')) {
    set('is_public', toDbBool(body.is_public));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    set('title', body.title || '');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'original_title')) {
    set('original_title', body.original_title || '');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'year')) {
    set('year', body.year || null);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'poster_path')) {
    set('poster_path', body.poster_path || '');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'overview')) {
    set('overview', body.overview || '');
  }

  if (Object.prototype.hasOwnProperty.call(body, 'genres')) {
    set('genres_json', JSON.stringify(Array.isArray(body.genres) ? body.genres : []));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'countries')) {
    set('countries_json', JSON.stringify(Array.isArray(body.countries) ? body.countries : []));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'cast')) {
    set('cast_json', JSON.stringify(Array.isArray(body.cast) ? body.cast : []));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'genres_json')) {
    set('genres_json', typeof body.genres_json === 'string' ? body.genres_json : JSON.stringify(body.genres_json || []));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'countries_json')) {
    set('countries_json', typeof body.countries_json === 'string' ? body.countries_json : JSON.stringify(body.countries_json || []));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'cast_json')) {
    set('cast_json', typeof body.cast_json === 'string' ? body.cast_json : JSON.stringify(body.cast_json || []));
  }

  return { fields, bindings };
}

function cors(env, request) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data, env, request, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors(env, request), 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function unauthorized(env, request) {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      ...cors(env, request),
      'WWW-Authenticate': 'Basic realm="admin"'
    }
  });
}

function checkAuth(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth) return false;

  const [type, encoded] = auth.split(' ');
  if (type !== 'Basic' || !encoded) return false;

  let decoded = '';
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }

  const sep = decoded.indexOf(':');
  if (sep < 0) return false;

  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return user === 'admin' && pass === env.ADMIN_PASSWORD;
}

async function serveAsset(request, env, assetPath) {
  if (!env.ASSETS) {
    return new Response('Assets binding is not configured', { status: 500 });
  }
  const url = new URL(request.url);
  const assetUrl = new URL(assetPath, url.origin);
  return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
}

async function tmdbFetch(env, path, params = {}) {
  const url = new URL('https://api.themoviedb.org/3' + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v) url.searchParams.set(k, v);
  });

  if (env.TMDB_BEARER_TOKEN) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.TMDB_BEARER_TOKEN}` } });
    return res.json();
  }

  url.searchParams.set('api_key', env.TMDB_API_KEY);
  const res = await fetch(url);
  return res.json();
}

async function searchTMDB(env, q, type, language) {
  if (!q) return [];
  const types = type === 'all' ? ['movie', 'tv'] : [type];
  const results = [];

  for (const t of types) {
    const data = await tmdbFetch(env, `/search/${t}`, { query: q, language });
    results.push(...(data.results || []).map((x) => ({ ...x, media_type: t })));
  }

  return results.slice(0, 20);
}

async function detailsTMDB(env, id, type, language) {
  if (!id || !type) {
    throw new Error('id and type are required');
  }

  const data = await tmdbFetch(env, `/${type}/${id}`, { language, append_to_response: 'credits' });
  return {
    details: data,
    credits: data.credits || { cast: [] }
  };
}
