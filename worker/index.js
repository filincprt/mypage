export default {
  async fetch(request, env) {
    const response = await handleRequest(request, env);
    return withSecurityHeaders(response);
  }
};

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors(env, request) });
    }

    try {
      if (path === '/catalog' && request.method === 'GET') {
        return serveAsset(request, env, '/catalog.html');
      }


      if (path === '/veronika' && request.method === 'GET') {
        return serveAsset(request, env, '/veronika.html');
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


function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);

  const securityHeaders = {
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline' https://bicea.org",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://irgvbrqwqpeqlokfkofw.supabase.co https://image.tmdb.org",
      "connect-src 'self' https://irgvbrqwqpeqlokfkofw.supabase.co https://get.geojs.io https://api.open-meteo.com",
      "frame-src 'self' https:",
      "upgrade-insecure-requests"
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()'
  };

  for (const [name, value] of Object.entries(securityHeaders)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
