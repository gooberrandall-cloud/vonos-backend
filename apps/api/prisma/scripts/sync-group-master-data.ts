/**
 * Unify payment accounts, expense categories, product categories, and brands
 * across VA + VISP + VSP + VW + VP (union by name), then soft-delete those
 * master-data rows from VC.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/sync-group-master-data.ts
 *   npx ts-node --transpile-only prisma/scripts/sync-group-master-data.ts --dry-run
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

const KEEP = ['VA', 'VISP', 'VSP', 'VW', 'VP'] as const;
const REMOVE_FROM = 'VC';

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

type PaRow = {
  name: string;
  accountNumber: string;
  accountType: string | null;
  accountSubType: string | null;
  accountDetails: string | null;
  note: string | null;
  isClosed: boolean;
  currency: string;
};

type CatRow = { name: string; code: string | null };
type ProdCatRow = {
  name: string;
  shortCode: string | null;
  categoryType: string | null;
  description: string | null;
  slug: string | null;
};
type BrandRow = { name: string; description: string | null };

async function buildUnions(tenantIds: string[]) {
  const [accounts, expenses, products, brands] = await Promise.all([
    prisma.paymentAccount.findMany({
      where: { tenantId: { in: tenantIds }, deletedAt: null },
    }),
    prisma.expenseCategory.findMany({
      where: { tenantId: { in: tenantIds }, deletedAt: null },
    }),
    prisma.productCategory.findMany({
      where: { tenantId: { in: tenantIds }, deletedAt: null },
    }),
    prisma.brand.findMany({
      where: { tenantId: { in: tenantIds }, deletedAt: null },
    }),
  ]);

  const paByName = new Map<string, PaRow>();
  for (const row of accounts) {
    const key = nameKey(row.name);
    if (!paByName.has(key)) {
      paByName.set(key, {
        name: row.name,
        accountNumber: row.accountNumber,
        accountType: row.accountType,
        accountSubType: row.accountSubType,
        accountDetails: row.accountDetails,
        note: row.note,
        isClosed: row.isClosed,
        currency: row.currency,
      });
    }
  }

  const ecByName = new Map<string, CatRow>();
  for (const row of expenses) {
    const key = nameKey(row.name);
    if (!ecByName.has(key)) {
      ecByName.set(key, { name: row.name, code: row.code });
    } else if (row.code && !ecByName.get(key)!.code) {
      ecByName.set(key, { name: row.name, code: row.code });
    }
  }

  const pcByName = new Map<string, ProdCatRow>();
  for (const row of products) {
    const key = nameKey(row.name);
    if (!pcByName.has(key)) {
      pcByName.set(key, {
        name: row.name,
        shortCode: row.shortCode,
        categoryType: row.categoryType,
        description: row.description,
        slug: row.slug,
      });
    }
  }

  const brandByName = new Map<string, BrandRow>();
  for (const row of brands) {
    const key = nameKey(row.name);
    if (!brandByName.has(key)) {
      brandByName.set(key, { name: row.name, description: row.description });
    }
  }

  return { paByName, ecByName, pcByName, brandByName };
}

async function ensureTenant(
  tenantId: string,
  code: string,
  unions: Awaited<ReturnType<typeof buildUnions>>,
) {
  const existingPa = await prisma.paymentAccount.findMany({
    where: { tenantId, deletedAt: null },
    select: { name: true, accountNumber: true },
  });
  const paNames = new Set(existingPa.map((r) => nameKey(r.name)));
  const paNumbers = new Set(
    existingPa
      .map((r) => r.accountNumber.trim().toLowerCase())
      .filter(Boolean),
  );

  let paCreated = 0;
  for (const row of unions.paByName.values()) {
    const n = nameKey(row.name);
    if (paNames.has(n)) continue;
    let accountNumber = row.accountNumber?.trim() || `CLONE-${n.slice(0, 24)}`;
    // Avoid colliding with an existing till number under a different name.
    if (paNumbers.has(accountNumber.toLowerCase())) {
      accountNumber = `${accountNumber}-${code}`;
    }
    if (!dryRun) {
      await prisma.paymentAccount.create({
        data: {
          tenantId,
          name: row.name,
          accountNumber,
          accountType: row.accountType,
          accountSubType: row.accountSubType,
          accountDetails: row.accountDetails,
          note: row.note,
          isClosed: row.isClosed,
          currency: row.currency,
          createdByName: 'system:sync-group-master-data',
        },
      });
    }
    paNames.add(n);
    paNumbers.add(accountNumber.toLowerCase());
    paCreated += 1;
  }

  const existingEc = await prisma.expenseCategory.findMany({
    where: { tenantId, deletedAt: null },
    select: { name: true },
  });
  const ecNames = new Set(existingEc.map((r) => nameKey(r.name)));
  let ecCreated = 0;
  for (const row of unions.ecByName.values()) {
    if (ecNames.has(nameKey(row.name))) continue;
    if (!dryRun) {
      await prisma.expenseCategory.create({
        data: { tenantId, name: row.name, code: row.code },
      });
    }
    ecNames.add(nameKey(row.name));
    ecCreated += 1;
  }

  const existingPc = await prisma.productCategory.findMany({
    where: { tenantId, deletedAt: null },
    select: { name: true },
  });
  const pcNames = new Set(existingPc.map((r) => nameKey(r.name)));
  let pcCreated = 0;
  for (const row of unions.pcByName.values()) {
    if (pcNames.has(nameKey(row.name))) continue;
    if (!dryRun) {
      await prisma.productCategory.create({
        data: {
          tenantId,
          name: row.name,
          shortCode: row.shortCode,
          categoryType: row.categoryType,
          description: row.description,
          slug: row.slug,
          parentId: null,
        },
      });
    }
    pcNames.add(nameKey(row.name));
    pcCreated += 1;
  }

  const existingBr = await prisma.brand.findMany({
    where: { tenantId, deletedAt: null },
    select: { name: true },
  });
  const brNames = new Set(existingBr.map((r) => nameKey(r.name)));
  let brCreated = 0;
  for (const row of unions.brandByName.values()) {
    if (brNames.has(nameKey(row.name))) continue;
    if (!dryRun) {
      await prisma.brand.create({
        data: {
          tenantId,
          name: row.name,
          description: row.description,
        },
      });
    }
    brNames.add(nameKey(row.name));
    brCreated += 1;
  }

  return {
    tenant: code,
    paymentAccountsCreated: paCreated,
    expenseCategoriesCreated: ecCreated,
    productCategoriesCreated: pcCreated,
    brandsCreated: brCreated,
    totals: {
      paymentAccounts: paNames.size,
      expenseCategories: ecNames.size,
      productCategories: pcNames.size,
      brands: brNames.size,
    },
  };
}

async function softDeleteVc(tenantId: string) {
  const now = new Date();
  if (dryRun) {
    const [pa, ec, pc, br] = await Promise.all([
      prisma.paymentAccount.count({ where: { tenantId, deletedAt: null } }),
      prisma.expenseCategory.count({ where: { tenantId, deletedAt: null } }),
      prisma.productCategory.count({ where: { tenantId, deletedAt: null } }),
      prisma.brand.count({ where: { tenantId, deletedAt: null } }),
    ]);
    return {
      tenant: REMOVE_FROM,
      softDeleted: {
        paymentAccounts: pa,
        expenseCategories: ec,
        productCategories: pc,
        brands: br,
      },
    };
  }

  const [pa, ec, pc, br] = await Promise.all([
    prisma.paymentAccount.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.expenseCategory.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.productCategory.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.brand.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now },
    }),
  ]);

  return {
    tenant: REMOVE_FROM,
    softDeleted: {
      paymentAccounts: pa.count,
      expenseCategories: ec.count,
      productCategories: pc.count,
      brands: br.count,
    },
  };
}

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: { code: { in: [...KEEP, REMOVE_FROM] } },
    select: { id: true, code: true },
  });
  const byCode = new Map(tenants.map((t) => [t.code, t]));
  for (const code of KEEP) {
    if (!byCode.has(code)) throw new Error(`Missing tenant ${code}`);
  }
  const vc = byCode.get(REMOVE_FROM);
  if (!vc) throw new Error(`Missing tenant ${REMOVE_FROM}`);

  const keepIds = KEEP.map((c) => byCode.get(c)!.id);
  const unions = await buildUnions(keepIds);

  console.log(
    `${dryRun ? '[dry-run] ' : ''}Union sizes: accounts=${unions.paByName.size} expenseCats=${unions.ecByName.size} productCats=${unions.pcByName.size} brands=${unions.brandByName.size}`,
  );

  for (const code of KEEP) {
    const t = byCode.get(code)!;
    const result = await ensureTenant(t.id, code, unions);
    console.log(JSON.stringify(result));
  }

  const removed = await softDeleteVc(vc.id);
  console.log(JSON.stringify(removed));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
