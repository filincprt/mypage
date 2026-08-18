import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

// Simple Supabase Edge Function for admin actions.
// Expects the following environment variables to be set in the function environment:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || Deno.env.get('VITE_SUPABASE_URL') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in env');
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS_HEADERS });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: {
      headers: { 'x-supabase-admin': '1' }
    }
  });

  try {
    if (req.method === 'GET') {
      // Return entries for admin list. Consider adding pagination later.
      const { data, error } = await supabase.from('entries').select('*').order('title', { ascending: true }).limit(1000);
      if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true, results: data }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    if (req.method === 'PATCH') {
      const payload = await req.json().catch(() => null);
      if (!payload || !payload.id) return new Response(JSON.stringify({ ok: false, error: 'Missing id in payload' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

      // Build an update object containing only allowed fields
      const allowed = ['view_status', 'favorite', 'rating', 'is_public', 'comment'];
      const update = {};
      for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(payload, k)) update[k] = payload[k];
      }

      // Basic sanitation: ensure numeric view_status becomes number or null
      if ('view_status' in update && update.view_status !== null && update.view_status !== undefined) {
        const vs = Number(update.view_status);
        update.view_status = Number.isFinite(vs) ? vs : null;
      }

      // Ensure favorite is stored in the DB type expected (some schemas use integer 0/1)
      if ('favorite' in update) {
        const fav = update.favorite;
        if (typeof fav === 'boolean') {
          update.favorite = fav ? 1 : 0;
        } else if (typeof fav === 'string') {
          const lower = fav.trim().toLowerCase();
          if (lower === 'true') update.favorite = 1;
          else if (lower === 'false') update.favorite = 0;
          else {
            const n = Number(fav);
            update.favorite = Number.isFinite(n) ? (n ? 1 : 0) : fav;
          }
        } else if (typeof fav === 'number') {
          update.favorite = fav ? 1 : 0;
        }
      }

      const { data, error } = await supabase.from('entries').update(update).eq('id', payload.id).select().maybeSingle();
      if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    if (req.method === 'DELETE') {
      const payload = await req.json().catch(() => null);
      if (!payload || !payload.id) return new Response(JSON.stringify({ ok: false, error: 'Missing id in payload' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      const { error } = await supabase.from('entries').delete().eq('id', payload.id);
      if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true, data: { id: payload.id } }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('Handler error', err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
});
