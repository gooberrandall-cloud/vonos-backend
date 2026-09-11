import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';

function loadDotEnv(path: string): void {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
}

loadDotEnv(resolve(__dirname, '../../.env'));
const prisma = new PrismaClient();

async function main() {
  const codes = ['VA', 'VP', 'VW', 'VISP', 'VSP'];
  const tenants = await prisma.tenant.findMany({
    where: { code: { in: codes }, deletedAt: null },
    select: { id: true, code: true },
  });

  for (const t of tenants) {
    const [all, active, inactive, deleted] = await Promise.all([
      prisma.customer.count({ where: { tenantId: t.id, deletedAt: null } }),
      prisma.customer.count({
        where: { tenantId: t.id, deletedAt: null, status: 'active' },
      }),
      prisma.customer.count({
        where: { tenantId: t.id, deletedAt: null, status: 'inactive' },
      }),
      prisma.customer.count({
        where: { tenantId: t.id, deletedAt: { not: null } },
      }),
    ]);
    console.log(t.code, { all, active, inactive, deleted });
  }

  // Sample: how many VA customers share a name with a VP customer?
  const va = tenants.find((t) => t.code === 'VA');
  const vp = tenants.find((t) => t.code === 'VP');
  if (va && vp) {
    const overlap = await prisma.$queryRawUnsafe<Array<{ shared: number }>>(
      `
      SELECT COUNT(*)::int AS shared
      FROM (
        SELECT UPPER(TRIM(name)) AS k FROM "Customer"
        WHERE "tenantId" = $1 AND "deletedAt" IS NULL
      ) a
      JOIN (
        SELECT UPPER(TRIM(name)) AS k FROM "Customer"
        WHERE "tenantId" = $2 AND "deletedAt" IS NULL
      ) b ON a.k = b.k
      `,
      va.id,
      vp.id,
    );
    console.log('VA∩VP name overlap', overlap[0]);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
