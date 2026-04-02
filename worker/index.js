const corsHeaders = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildMessage(fields) {
  const rows = [
    '🆕 <b>Новая заявка на дистрибьюцию</b>',
    '',
    `<b>Имя:</b> ${escapeHtml(fields.name || '—')}`,
    `<b>Контакт:</b> ${escapeHtml(fields.contact || '—')}`,
    `<b>Тип релиза:</b> ${escapeHtml(fields.releaseType || '—')}`,
    `<b>Название:</b> ${escapeHtml(fields.releaseTitle || '—')}`,
    `<b>Описание:</b> ${escapeHtml(fields.details || '—')}`,
  ];

  if (fields.demoLink) rows.push(`<b>Ссылка:</b> ${escapeHtml(fields.demoLink)}`);
  if (fields.extra) rows.push(`<b>Дополнительно:</b> ${escapeHtml(fields.extra)}`);
  rows.push('', `🕒 ${new Date().toISOString()}`);
  return rows.join('\n');
}

async function sendTelegramMessage(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status}`);
  }
}

async function sendTelegramFile(env, file, caption) {
  if (!file || typeof file === 'string' || !file.size) return;

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`;
  const form = new FormData();
  form.append('chat_id', env.TELEGRAM_CHAT_ID);
  form.append('caption', caption);
  form.append('document', file, file.name || 'demo.mp3');

  const response = await fetch(url, { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error(`Telegram sendDocument failed: ${response.status}`);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const allowOrigin = env.ALLOWED_ORIGIN || origin || '*';
    const headers = {
      ...corsHeaders,
      'Access-Control-Allow-Origin': allowOrigin,
      'Content-Type': 'application/json; charset=utf-8',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers });
    }

    try {
      const form = await request.formData();
      if ((form.get('company') || '').toString().trim()) {
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      const fields = {
        name: (form.get('name') || '').toString().trim(),
        contact: (form.get('contact') || '').toString().trim(),
        releaseType: (form.get('releaseType') || '').toString().trim(),
        releaseTitle: (form.get('releaseTitle') || '').toString().trim(),
        details: (form.get('details') || '').toString().trim(),
        demoLink: (form.get('demoLink') || '').toString().trim(),
        extra: (form.get('extra') || '').toString().trim(),
      };

      for (const key of ['name', 'contact', 'releaseType', 'releaseTitle', 'details']) {
        if (!fields[key]) {
          return new Response(JSON.stringify({ ok: false, error: `Missing field: ${key}` }), { status: 400, headers });
        }
      }

      const demoFile = form.get('demoFile');
      const message = buildMessage(fields);

      await sendTelegramMessage(env, message);
      if (demoFile) {
        await sendTelegramFile(env, demoFile, `Демо к заявке: ${fields.releaseTitle}`);
      }

      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: error?.message || 'Unknown error' }), {
        status: 500,
        headers,
      });
    }
  },
};