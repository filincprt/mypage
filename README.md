# mypage

Personal page for filin_cprt.

## Label flow

- Home page: `index.html`
- Label page: `label.html`
- Worker code: `worker/index.js`

## Cloudflare Worker secrets

Set these values in Cloudflare before deploying:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `ALLOWED_ORIGIN`

## Form endpoint

In `label.html`, replace `https://YOUR-WORKER.workers.dev` with the URL of your deployed Worker.

## Deploy notes

The Worker receives the form as `multipart/form-data`, sends a Telegram message with the submission details, and forwards the demo file as a document when one is attached.
