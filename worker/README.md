# Checkout Enforcement Worker

Server-side gate for beat delivery. The site's JavaScript never sees the
NOWPayments key or the Drive URLs — only this Worker does.

## What it enforces

1. `POST /api/checkout` — creates the NOWPayments payment (API key stays here)
2. `POST /api/ipn` — receives payment webhooks; verifies the
   `x-nowpayments-sig` HMAC-SHA512 signature with your IPN secret; on
   `finished`, marks the order released and emails the download links
3. `GET /api/status?order_id=…` — live status for the popup; returns the
   links **only** after the IPN handler has marked the order released

## Deploy

```bash
cd worker
npm install

npx wrangler kv namespace create ORDERS     # paste the id into wrangler.toml

npx wrangler secret put NOWPAYMENTS_API_KEY
npx wrangler secret put NOWPAYMENTS_IPN_SECRET
npx wrangler secret put STATICFORMS_API_KEY
npx wrangler secret put BEAT_LINKS          # paste JSON from step below

npm run deploy
```

## BEAT_LINKS value (paste when prompted — keep out of git)

```json
{"beat1":"https://drive.google.com/uc?export=download&id=1TIk-Yn1JRcUcNrazPb2MQj1-Aj-nYA7I","beat2":"https://drive.google.com/uc?export=download&id=1gfei4yTBXG0RSJ9lb2MeKnbxeZ6WPmok","beat3":"https://drive.google.com/uc?export=download&id=1BWZZkNSX6ckWC1CUuyQzsV9w1Vb1Rzfb","beat4":"https://drive.google.com/uc?export=download&id=1pfygraPifGckX5X-ZzIf6lZVftSVrc31","beat5":"https://drive.google.com/uc?export=download&id=1RMQh5uFfhgUzYt7r0DkaExl_kveYu_-0","beat6":"https://drive.google.com/uc?export=download&id=128f5lN8Xb5XeZ8AUe40cEhDNQy768Utj","beat7":"https://drive.google.com/uc?export=download&id=1lCqpxI0GHVInSpLS23LZbJVpXNovRNUL"}
```

Keys must match the `id` fields in script.js (`beat1` … `beat7`).

## Finish line

1. Set the deployed URL in script.js → `WORKER_URL`
2. In NOWPayments dashboard, confirm the IPN callback URL points to
   `<worker-url>/api/ipn` and that your IPN secret matches
   `NOWPAYMENTS_IPN_SECRET` (also set `ALLOWED_ORIGIN` in wrangler.toml
   to your storefront origin, then redeploy)

Local dev: copy `.dev.vars.example` → `.dev.vars`, then `npm run dev`.
