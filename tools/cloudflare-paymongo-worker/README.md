# Self-Hosted PayMongo Worker (Your Own Cloudflare Account)

By default, photobooth4u handles PayMongo QR Ph API calls and webhooks on its own Netlify backend (`photobooth4u.netlify.app/api/pay` and `/api/pay/hook`), with your secret key encrypted at rest (AES-256-GCM).

If you prefer to host PayMongo **100% on your own Cloudflare account** so your `sk_live_` secret key and webhook signing secret never touch photobooth4u's servers, deploy this Worker in under 5 minutes.

## 1. Deploy to your Cloudflare account

```bash
cd tools/cloudflare-paymongo-worker
npx wrangler login
npx wrangler deploy
```

Note your Worker URL, e.g. `https://photobooth4u-paymongo.<your-subdomain>.workers.dev`.

## 2. Add your secrets (stored only in Cloudflare)

```bash
# Required: your PayMongo Secret Key (sk_live_... or sk_test_...)
npx wrangler secret put PAYMONGO_SECRET_KEY

# Recommended: any random secret string you paste into the booth's "Booth access token" box
npx wrangler secret put BOOTH_TOKEN
```

## 3. Optional: Instant webhook confirmation (KV + PayMongo webhook)

Even without KV, the Worker checks `GET /v1/payment_intents/:id` directly on PayMongo every 2.5 seconds and confirms payment automatically.

To enable instant webhook notifications too:

1. Create a KV namespace:
   ```bash
   npx wrangler kv namespace create PAY_KV
   ```
2. Uncomment the `[[kv_namespaces]]` lines in `wrangler.toml`, paste the namespace `id`, and run `npx wrangler deploy`.
3. In PayMongo Dashboard (or via PayMongo `/v1/webhooks` API), register a webhook for `payment.paid` pointing to:
   ```
   https://photobooth4u-paymongo.<your-subdomain>.workers.dev/webhook
   ```
4. Save the webhook signing secret (`whsk_...`) into Cloudflare:
   ```bash
   npx wrangler secret put PAYMONGO_WEBHOOK_SECRET
   ```

## 4. Connect it in photobooth4u

1. Open the booth (Web, Android Offline App, Windows/Mac App) → **Setup → 7 Session → Guest payment**.
2. Open **Self-hosted PayMongo (your own Cloudflare Worker · optional)**.
3. Paste your Worker URL (and `BOOTH_TOKEN` if you set one), tap **Test connection**, then **Save Worker**.
4. Select **QR payment** (or **QR + vouchers**).

Your Worker URL and token are saved **only in that device's localStorage** — photobooth4u's server never receives your PayMongo keys or webhook secret.
