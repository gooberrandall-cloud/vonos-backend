# vonos-backend
NestJS API + Prisma for the Vonos multi-tenant platform.

## Vercel

Import this repo. Either works:

- **Root Directory:** leave empty (uses root `vercel.json`)
- **Root Directory:** `apps/api` (uses `apps/api/vercel.json`)

Env: `DATABASE_URL`, `JWT_SECRET`, `JWT_ACCESS_EXPIRES`, `JWT_REFRESH_EXPIRES`, `WEB_ORIGIN`, `NODE_ENV=production`

## Local

```bash
npm install
npm run build
cd apps/api && npx prisma migrate deploy
npm run dev --workspace=api
```
