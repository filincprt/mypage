export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const allowOrigin = env.ALLOWED_ORIGIN || origin || '*';

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Content-Type': 'application/json; charset=utf-8',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
        status: 405,
        headers: corsHeaders,
      });
    }

    if (!env.TMDB_BEARER_TOKEN) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing TMDB_BEARER_TOKEN' }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '');
    const language = url.searchParams.get('language') || 'ru-RU';

    try {
      if (pathname.endsWith('/search')) {
        const q = (url.searchParams.get('q') || '').trim();
        const type = (url.searchParams.get('type') || 'all').trim();

        if (!q) {
          return new Response(JSON.stringify({ ok: true, results: [] }), { headers: corsHeaders });
        }

        const results = await searchTmdb({ env, q, type, language });
        return new Response(JSON.stringify({ ok: true, results }), { headers: corsHeaders });
      }

      if (pathname.endsWith('/details')) {
        const type = (url.searchParams.get('type') || '').trim();
        const id = (url.searchParams.get('id') || '').trim();

        if (!type || !id) {
          return new Response(JSON.stringify({ ok: false, error: 'Missing type or id' }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        if (!['movie', 'tv'].includes(type)) {
          return new Response(JSON.stringify({ ok: false, error: 'type must be movie or tv' }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const details = await fetchTmdbJson(env, `https://api.themoviedb.org/3/${type}/${id}?language=${encodeURIComponent(language)}&append_to_response=credits`);
        const credits = details.credits?.cast || [];

        return new Response(JSON.stringify({
          ok: true,
          details: normalizeDetails(details, type),
          credits: { cast: credits.slice(0, 20).map(normalizeCast) },
        }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
        status: 404,
        headers: corsHeaders,
      });
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: error?.message || 'Unknown error' }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};

async function searchTmdb({ env, q, type, language }) {
  const tasks = [];

  if (type === 'movie' || type === 'all') {
    tasks.push(fetchTmdbJson(env, `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(q)}&language=${encodeURIComponent(language)}&include_adult=false`)
      .then(data => (data.results || []).map(item => normalizeSearch(item, 'movie'))));
  }

  if (type === 'tv' || type === 'all') {
    tasks.push(fetchTmdbJson(env, `https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(q)}&language=${encodeURIComponent(language)}&include_adult=false`)
      .then(data => (data.results || []).map(item => normalizeSearch(item, 'tv'))));
  }

  const groups = await Promise.all(tasks);
  const merged = groups.flat();

  const seen = new Set();
  const unique = [];
  for (const item of merged) {
    const key = `${item.media_type}_${item.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  return unique.sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 24);
}

async function fetchTmdbJson(env, url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.TMDB_BEARER_TOKEN}`,
      Accept: 'application/json',
    },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`TMDb returned invalid JSON: ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const message = data?.status_message || data?.success === false && data?.status_message || `TMDb error ${res.status}`;
    throw new Error(message);
  }

  return data;
}

function normalizeSearch(item, mediaType) {
  return {
    id: item.id,
    media_type: mediaType,
    title: item.title || item.name || 'Без названия',
    original_title: item.original_title || item.original_name || '',
    overview: item.overview || '',
    poster_path: item.poster_path || '',
    backdrop_path: item.backdrop_path || '',
    release_date: item.release_date || item.first_air_date || '',
    popularity: item.popularity || 0,
    vote_average: item.vote_average || 0,
    vote_count: item.vote_count || 0,
    original_language: item.original_language || '',
  };
}

function normalizeDetails(item, mediaType) {
  return {
    id: item.id,
    media_type: mediaType,
    title: item.title || item.name || 'Без названия',
    original_title: item.original_title || item.original_name || '',
    overview: item.overview || '',
    poster_path: item.poster_path || '',
    backdrop_path: item.backdrop_path || '',
    release_date: item.release_date || item.first_air_date || '',
    vote_average: item.vote_average || 0,
    vote_count: item.vote_count || 0,
    original_language: item.original_language || '',
    origin_country: item.origin_country || [],
    genres: Array.isArray(item.genres) ? item.genres.map(g => ({ id: g.id, name: g.name })) : [],
    runtime: item.runtime || null,
    number_of_seasons: item.number_of_seasons || null,
    number_of_episodes: item.number_of_episodes || null,
    status: item.status || '',
    homepage: item.homepage || '',
    tagline: item.tagline || '',
    credits: item.credits || { cast: [] },
  };
}

function normalizeCast(person) {
  return {
    id: person.id,
    name: person.name || '',
    character: person.character || '',
    profile_path: person.profile_path || '',
    order: person.order ?? 0,
  };
}
