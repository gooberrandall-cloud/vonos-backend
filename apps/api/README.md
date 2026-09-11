
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
| `PUBLIC_SITE_URL` | No | Public marketing site for `/track` links (defaults to first `WEB_ORIGIN`) |
| `WHATSAPP_ACCESS_TOKEN` | For auto WhatsApp | Meta Cloud API permanent token |
| `WHATSAPP_PHONE_NUMBER_ID` | For auto WhatsApp | Meta phone number id |
| `WHATSAPP_TEMPLATE_NAME` | Recommended | Approved template for outbound status notifies (body params: name, plate, status, track URL) |
| `WHATSAPP_TEMPLATE_LANG` | No | Template language code (default `en`) |
| `WHATSAPP_AUTO_NOTIFY` | No | `true`/`false` — auto-notify on job status advance (default on) |
| `NODE_ENV` | **Yes** | `production` |
| `PORT` | No | Railway sets this automatically |

### WhatsApp job status notifies

When staff update a VA/VP job status (checkbox **Notify customer on WhatsApp**), the API:

1. Resolves phone from **vehicle owner phone**, else **customer phone**
2. Builds a `/track?name=&reg=` link
3. **If** `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` are set → sends via Meta Cloud API (template if `WHATSAPP_TEMPLATE_NAME` is set)
4. **Else** → returns a `wa.me` link and the UI opens WhatsApp Web for staff to tap Send

Without Meta credentials, messages are **not** auto-sent — only opened for staff.

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
