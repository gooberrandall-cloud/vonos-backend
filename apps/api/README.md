
# Vonos API (NestJS + Prisma)

Backend for the Vonos multi-tenant platform. Deployed on Vercel as a serverless Express handler.

## Railway

Import [vonos-backend](https://github.com/ZyhvarZeGreat/vonos-backend) with **Root Directory** left empty (repo root).

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
| `JWT_ACCESS_EXPIRES` | No | `2h` (default if omitted) |
| `JWT_REFRESH_EXPIRES` | No | `7d` |
| `WEB_ORIGIN` | **Yes** | Your frontend URL, e.g. `https://app.vonosautos.com` |
| `NODE_ENV` | **Yes** | `production` |
| `PORT` | No | Railway sets this automatically |

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
| `JWT_ACCESS_EXPIRES` | `2h` |
| `JWT_REFRESH_EXPIRES` | `7d` |
| `WEB_ORIGIN` | `https://app.vonosautos.com` |
| `NODE_ENV` | `production` |

Health check: `GET /health`
