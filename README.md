# Garment mockup studio

## Run with accounts (recommended)

1. Copy `.env.example` to `.env` and set `ADMIN_EMAIL` / `ADMIN_PASSWORD` (and optional Stripe keys).
2. `npm install` then `npm start` and open http://localhost:3000

**Local database:** if `DATABASE_URL` is unset, the app uses SQLite in `data/app.db`.

### Deploy on Vercel (free / hobby)

1. Create a **Neon** (or other Postgres) database and copy the connection string.
2. In the Vercel project → **Settings → Environment Variables**, add at least:
   - `DATABASE_URL` — your Postgres URL (required on Vercel; SQLite cannot persist on serverless).
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD` — used only on **first deploy** to create the admin if the DB is empty.
3. Connect the Git repo and deploy. Open your `.vercel.app` URL.
4. Optional Stripe webhook URL: `https://<your-project>.vercel.app/api/stripe/webhook` (same `STRIPE_*` vars as locally).

The repo includes `vercel.json` (rewrite all traffic to one serverless function) and `api/index.js`. Serverless **maxDuration** is set to 10s to stay within typical hobby limits; heavy Stripe webhook work should still fit.

Sign-in is required. New users request access on WhatsApp **+971 56 504 1443**; an admin creates accounts under **Admin** (after logging in as admin).

- **Subscription**: the Stripe link is Stripe-hosted (no return URL on this app). After payment, an admin grants access in **Admin** (e.g. **+30 days**), or you can optionally add Stripe webhooks — see `.env.example`.
- **Static-only**: you can still open `public/index.html` from a static server, but sign-in and usage APIs require the Node server.

## Production (self-hosted)

1. **Node + Postgres**: use `DATABASE_URL` (Node 20 cannot use the built-in SQLite path; use Postgres or Node 24+ for SQLite). Set `NODE_ENV=production`.
2. **HTTPS**: use real TLS on your domain; only set `COOKIE_SECURE=false` while testing over plain HTTP.
3. **Process + reverse proxy**: see `deploy/clothing-design.service.example` and `deploy/nginx-site.conf.example`. The app enables **response compression** and **sensible static `Cache-Control`** when `NODE_ENV=production`.
4. **Server-side file mirror**: when signed in on a normal VPS (not Vercel), garment and design picks are **also POSTed** to `data/uploads/` (same session cookie). This does **not** run masking on the server; it stores a per-user copy. Disable with `DISABLE_SERVER_UPLOADS=1`. `/api/health` includes `server_uploads`.
5. **Performance**: mockup **masking and export** run in the browser; use reasonably sized photos (e.g. ~2000px wide) for faster masking. Nginx **gzip** for JS/CSS is configured in the example site.

For **same-hue** product vs background (e.g. red hoodie on red wall), the in-browser cutout is limited. Use optional **rembg** — see `tools/README.md` and step 1 → *Same-color garment vs background* in the app.