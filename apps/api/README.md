
# Vonos API (NestJS + Prisma)

Backend for the Vonos multi-tenant platform. Deployed on Vercel as a serverless Express handler.

## Railway

Import [vonos-backend](https://github.com/gooberrandall-cloud/vonos-backend) with **Root Directory** left empty (repo root).

Public URL (gooberrandall): `https://api-production-a4a1.up.railway.app`  
Do **not** use the legacy Zyhvar URL `https://vonos-backend-production.up.railway.app` for the gooberrandall frontend.

In **Service Settings → Config-as-code**, set the config file path to `/railway.toml`.

### Environment variables (Railway dashboard)

Env vars are **not in git**. Set them in Railway:

1. Open your **Project** → select the **API service**
2. Go to **Variables** (or **Settings → Variables**)
3. Add each variable below (or use **Add Reference** if you provisioned Postgres via Railway)

| Variable | Required | Example / notes |
|----------|----------|-----------------|
| `DATABASE_URL` | **Yes** | `postgresql://user:pass@host:5432/db?sslmode=require` — from Neon or Railway Postgres |
| `JWT_SECRET` | **Yes** | Long random string (e.g. `openssl rand -base64 32`) |
| `JWT_ACCESS_EXPIRES` | No | `3h` (default if omitted) |
| `JWT_REFRESH_EXPIRES` | No | `7d` |
| `WEB_ORIGIN` | **Yes** | Your frontend URL, e.g. `https://app.vonosautos.com` |
| `PUBLIC_SITE_URL` | No | Public marketing site for `/track` / `/job/:token` links (defaults to first `WEB_ORIGIN`) |
| `WHATSAPP_PROVIDER` | WhatsApp primary | `baileys` (MoovMart — default) · `unipile` · `cloud_api` · `auto` |
| `WHATSAPP_AUTH_DIR` | Baileys | Session folder (default `./auth_info_baileys`; on Railway with `/data` volume → `/data/auth_info_baileys`) |
| `UNIPILE_DSN` | Unipile fallback | Unipile DSN host, e.g. `https://apiX.unipile.com:PORT` ([docs](https://developer.unipile.com/docs/getting-started)) |
| `UNIPILE_API_KEY` | Unipile fallback | Unipile access token (`X-API-KEY`) |
| `UNIPILE_WHATSAPP_ACCOUNT_ID` | Unipile fallback | Connected WhatsApp account id from Unipile Accounts |
| `WHATSAPP_ACCESS_TOKEN` | Meta fallback | Meta Cloud API permanent token |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta fallback | Meta phone number id |
| `WHATSAPP_TEMPLATE_NAME` | Meta recommended | Approved template for outbound status notifies (body params: name, plate, status, track URL) |
| `WHATSAPP_TEMPLATE_LANG` | No | Template language code (default `en`) |
| `WHATSAPP_AUTO_NOTIFY` | No | `true`/`false` — auto-notify on job status advance (default on) |
| `WHATSAPP_WELCOME_ON_PHONE` | No | `true`/`false` — send welcome WhatsApp when a customer/vehicle phone is newly saved (default on) |
| `NODE_ENV` | **Yes** | `production` |
| `PORT` | No | Railway sets this automatically |

### WhatsApp job status notifies

When staff update a VA/VP job status (checkbox **Notify customer on WhatsApp**), the API:

1. Resolves phone from **vehicle owner phone**, else **customer phone**
2. Builds a signed `/job/<token>` track link
3. **MoovMart first:** if Baileys is connected → send via WhatsApp Web ([Baileys](https://github.com/WhiskeySockets/Baileys))
4. **Unipile later:** else if Unipile env is set → [Unipile `POST /chats`](https://developer.unipile.com/docs/send-messages)
5. **Else if** Meta Cloud API env is set → Meta (template if `WHATSAPP_TEMPLATE_NAME` is set)
6. **Else** → returns a `wa.me` link and the UI opens WhatsApp Web for staff to tap Send

Baileys needs a **long-lived** API process (Railway). It does **not** work on Vercel serverless.

#### Baileys on Railway (primary — MoovMart method)

1. In Railway → API service → **Volumes**: mount persistent disk at `/data` (so QR session survives deploys)
2. Set variables:

```bash
WHATSAPP_PROVIDER=baileys
WHATSAPP_AUTH_DIR=/data/auth_info_baileys   # optional if /data exists
PUBLIC_SITE_URL=https://www.vonosgroup.com
```

3. Redeploy, then as **super_admin** (Bearer JWT):

```bash
# Status
curl -H "Authorization: Bearer $TOKEN" https://YOUR_API/whatsapp/status

# QR (open qrDataUrl in a browser tab → WhatsApp → Linked devices → Link a device)
curl -H "Authorization: Bearer $TOKEN" https://YOUR_API/whatsapp/baileys/qr

# Smoke send
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"phone":"08100331727"}' https://YOUR_API/whatsapp/test
```

Local: same `WHATSAPP_PROVIDER=baileys` in `apps/api/.env`, restart Nest, then hit `GET /whatsapp/baileys/qr`. Session lands in `apps/api/auth_info_baileys/` (gitignored).

To force a fresh QR: `POST /whatsapp/baileys/reconnect` with `{"clearSession":true}`.

#### Unipile (fallback when Baileys is offline)

1. Create a Unipile account → copy **DSN** + **API key**
2. In Unipile **Accounts**, connect WhatsApp (QR or pairing) → copy that **account id**
3. Put in `apps/api/.env` (keep `WHATSAPP_PROVIDER=baileys` so MoovMart stays primary; Unipile is used only when Baileys is not connected — or set `WHATSAPP_PROVIDER=unipile` to force Unipile):

```bash
UNIPILE_DSN=https://apiX.unipile.com:PORT
UNIPILE_API_KEY=...
UNIPILE_WHATSAPP_ACCOUNT_ID=...
PUBLIC_SITE_URL=https://www.vonosgroup.com   # or http://localhost:3000
```

4. Smoke send:

```bash
cd apps/api && npx tsx prisma/scripts/test-unipile-whatsapp.ts 08031234567
```

Expect `channel: "unipile"` and `sent: true`. Then flip a job status with notify on in the app.

If you add a **Railway PostgreSQL** plugin to the same project, link it to the API service — Railway can inject `DATABASE_URL` for you.

Optional if start command is ignored: `RAILPACK_START_CMD=npm run start:railway --workspace=api`

Health check: `GET /health`

## Vercel setup

Import [vonos-backend](https://github.com/ZyhvarZeGreat/vonos-backend) and set **Root Directory** to `apps/api`.

Required env vars:

| Variable | Example |
|----------|---------|
| `DATABASE_URL` | Neon Postgres connection string |
| `JWT_SECRET` | long random secret |
| `JWT_ACCESS_EXPIRES` | `3h` |
| `JWT_REFRESH_EXPIRES` | `7d` |
| `WEB_ORIGIN` | `https://app.vonosautos.com` |
| `NODE_ENV` | `production` |

Health check: `GET /health`
