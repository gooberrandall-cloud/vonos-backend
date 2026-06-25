
# Vonos API (NestJS + Prisma)

Backend for the Vonos multi-tenant platform. Deployed on Vercel as a serverless Express handler.

## Vercel setup

Import [vonos-backend](https://github.com/ZyhvarZeGreat/vonos-backend) and set **Root Directory** to `apps/api`.

Required env vars:

| Variable | Example |
|----------|---------|
| `DATABASE_URL` | Neon Postgres connection string |
| `JWT_SECRET` | long random secret |
| `JWT_ACCESS_EXPIRES` | `15m` |
| `JWT_REFRESH_EXPIRES` | `7d` |
| `WEB_ORIGIN` | `https://app.vonosautos.com` |
| `NODE_ENV` | `production` |

Health check: `GET /health`
