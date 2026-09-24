#!/usr/bin/env bash
set -euo pipefail

# Workspace start runs with cwd = apps/api; fall back to monorepo layout.
if [[ -f prisma/schema.prisma ]]; then
  API_DIR="."
elif [[ -f apps/api/prisma/schema.prisma ]]; then
  API_DIR="apps/api"
else
  echo "railway-start: prisma schema not found" >&2
  exit 1
fi

cd "$API_DIR"

echo "railway-start: syncing database schema (non-fatal)…"
npx prisma migrate deploy || npx prisma db push --skip-generate || {
  echo "railway-start: schema sync failed; starting API anyway"
}

echo "railway-start: launching API…"
exec node dist/main
