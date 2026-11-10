#!/usr/bin/env node
/**
 * One-off: let stock/store-facing roles manage opening stock.
 *   Stock Keeper     -> product.view + product.opening_stock (had none)
 *   MANAGER          -> product.opening_stock (already has product.view)
 *   Assistant Manager-> product.opening_stock (already has product.view)
 * Idempotent — only adds keys that are missing.
 */
import { PrismaClient } from '@prisma/client';

const GRANTS = {
  'stock keeper': ['product.view', 'product.opening_stock'],
  manager: ['product.opening_stock'],
  'assistant manager': ['product.opening_stock'],
};

const prisma = new PrismaClient();

async function main() {
  const names = Object.keys(GRANTS);
  const roles = await prisma.tenantRole.findMany({
    where: {
      deletedAt: null,
      name: { in: names, mode: 'insensitive' },
    },
    select: { id: true, tenantId: true, name: true, permissions: true },
    orderBy: { name: 'asc' },
  });

  console.log(`Matching roles found: ${roles.length}`);
  for (const role of roles) {
    const wanted = GRANTS[role.name.trim().toLowerCase()] ?? [];
    const missing = wanted.filter((k) => !role.permissions.includes(k));
    if (missing.length === 0) {
      console.log(`  ${role.name} @ ${role.tenantId}: already granted`);
      continue;
    }
    await prisma.tenantRole.update({
      where: { id: role.id },
      data: { permissions: [...role.permissions, ...missing] },
    });
    console.log(`  ${role.name} @ ${role.tenantId}: +${missing.join(', +')}`);
  }
}

main()
  .catch((e) => {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
