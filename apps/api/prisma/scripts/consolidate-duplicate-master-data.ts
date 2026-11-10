/**
 * Consolidate duplicate master-data rows per tenant by (case-insensitive) name.
 *
 * Goal: keep ONE canonical row per normalized name and re-point all FK references
 * (where applicable) to prevent duplicates from appearing in pickers and exports.
 *
 * Supported tables:
 * - paymentAccount: updates AccountTransaction.accountId, Payment.accountId, Expense.accountId
 * - expenseCategory: updates Expense.categoryId
 * - brand: updates Item.brandId
 * - productCategory: best-effort updates ProductCategory.parentId (string-based)
 *
 * Duplicates are soft-deleted (deletedAt set) after references are re-mapped.
 *
 * Usage:
 *   npx ts-node --transpile-only prisma/scripts/consolidate-duplicate-master-data.ts
 *   TENANTS=VA,VISp,VSP npx ts-node --transpile-only prisma/scripts/consolidate-duplicate-master-data.ts
 *   ... --dry-run  (no writes)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const tenantCodes = (process.env.TENANTS ?? 'VA')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

type PaymentAccount = { id: string; tenantId: string; name: string; isClosed: boolean; createdAt: Date };
type ExpenseCategory = { id: string; tenantId: string; name: string; code: string | null; createdAt: Date };
type Brand = { id: string; tenantId: string; name: string; description: string | null; createdAt: Date };
type ProductCategory = { id: string; tenantId: string; name: string; slug: string | null; categoryType: string | null; parentId: string | null; createdAt: Date };

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function pickPaymentCanonical(rows: PaymentAccount[]): PaymentAccount {
  // Prefer open accounts; then earliest.
  const open = rows.filter((r) => !r.isClosed);
  const pool = open.length > 0 ? open : rows;
  return pool.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
}

function pickExpenseCategoryCanonical(rows: ExpenseCategory[]): ExpenseCategory {
  // Prefer rows with a code; then earliest.
  const withCode = rows.filter((r) => Boolean(r.code));
  const pool = withCode.length > 0 ? withCode : rows;
  return pool.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
}

function pickBrandCanonical(rows: Brand[]): Brand {
  // Prefer rows with a description; then earliest.
  const withDesc = rows.filter((r) => Boolean(r.description));
  const pool = withDesc.length > 0 ? withDesc : rows;
  return pool.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
}

function pickProductCategoryCanonical(rows: ProductCategory[]): ProductCategory {
  // Prefer slug; then categoryType; then earliest.
  const withSlug = rows.filter((r) => Boolean(r.slug));
  const pool1 = withSlug.length > 0 ? withSlug : rows;
  const withType = pool1.filter((r) => Boolean(r.categoryType));
  const pool2 = withType.length > 0 ? withType : pool1;
  return pool2.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
}

async function processPaymentAccounts(tenantId: string): Promise<void> {
  const rows = await prisma.paymentAccount.findMany({
    where: { tenantId, deletedAt: null },
    select: { id: true, tenantId: true, name: true, isClosed: true, createdAt: true },
  });

  const buckets = new Map<string, PaymentAccount[]>();
  for (const row of rows) {
    const k = norm(row.name);
    const list = buckets.get(k) ?? [];
    list.push(row);
    buckets.set(k, list);
  }

  for (const [k, group] of buckets.entries()) {
    if (group.length <= 1) continue;

    const canonical = pickPaymentCanonical(group);
    const dupes = group.filter((r) => r.id !== canonical.id);

    console.log(`[paymentAccount] tenant=${tenantId} name=${k} canonical=${canonical.id} dupes=${dupes.length}`);
    if (dryRun) continue;

    const dupIds = dupes.map((d) => d.id);
    await prisma.accountTransaction.updateMany({
      where: { tenantId, accountId: { in: dupIds } },
      data: { accountId: canonical.id },
    });
    await prisma.payment.updateMany({
      where: { tenantId, accountId: { in: dupIds } },
      data: { accountId: canonical.id },
    });
    await prisma.expense.updateMany({
      where: { tenantId, accountId: { in: dupIds } },
      data: { accountId: canonical.id },
    });

    await prisma.paymentAccount.updateMany({
      where: { id: { in: dupIds }, tenantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }
}

async function processExpenseCategories(tenantId: string): Promise<void> {
  const rows = await prisma.expenseCategory.findMany({
    where: { tenantId, deletedAt: null },
    select: { id: true, tenantId: true, name: true, code: true, createdAt: true },
  });

  const buckets = new Map<string, ExpenseCategory[]>();
  for (const row of rows) {
    const k = norm(row.name);
    const list = buckets.get(k) ?? [];
    list.push(row);
    buckets.set(k, list);
  }

  for (const [k, group] of buckets.entries()) {
    if (group.length <= 1) continue;

    const canonical = pickExpenseCategoryCanonical(group);
    const dupes = group.filter((r) => r.id !== canonical.id);

    console.log(`[expenseCategory] tenant=${tenantId} name=${k} canonical=${canonical.id} dupes=${dupes.length}`);
    if (dryRun) continue;

    const dupIds = dupes.map((d) => d.id);
    await prisma.expense.updateMany({
      where: { tenantId, categoryId: { in: dupIds } },
      data: { categoryId: canonical.id },
    });

    await prisma.expenseCategory.updateMany({
      where: { id: { in: dupIds }, tenantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }
}

async function processBrands(tenantId: string): Promise<void> {
  const rows = await prisma.brand.findMany({
    where: { tenantId, deletedAt: null },
    select: { id: true, tenantId: true, name: true, description: true, createdAt: true },
  });

  const buckets = new Map<string, Brand[]>();
  for (const row of rows) {
    const k = norm(row.name);
    const list = buckets.get(k) ?? [];
    list.push(row);
    buckets.set(k, list);
  }

  for (const [k, group] of buckets.entries()) {
    if (group.length <= 1) continue;

    const canonical = pickBrandCanonical(group);
    const dupes = group.filter((r) => r.id !== canonical.id);

    console.log(`[brand] tenant=${tenantId} name=${k} canonical=${canonical.id} dupes=${dupes.length}`);
    if (dryRun) continue;

    const dupIds = dupes.map((d) => d.id);
    await prisma.item.updateMany({
      where: { tenantId, brandId: { in: dupIds } },
      data: { brandId: canonical.id },
    });

    await prisma.brand.updateMany({
      where: { id: { in: dupIds }, tenantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }
}

async function processProductCategories(tenantId: string): Promise<void> {
  const rows = await prisma.productCategory.findMany({
    where: { tenantId, deletedAt: null },
    select: {
      id: true,
      tenantId: true,
      name: true,
      slug: true,
      categoryType: true,
      parentId: true,
      createdAt: true,
    },
  });

  const buckets = new Map<string, ProductCategory[]>();
  for (const row of rows) {
    const k = norm(row.name);
    const list = buckets.get(k) ?? [];
    list.push(row);
    buckets.set(k, list);
  }

  for (const [k, group] of buckets.entries()) {
    if (group.length <= 1) continue;

    const canonical = pickProductCategoryCanonical(group);
    const dupes = group.filter((r) => r.id !== canonical.id);
    const dupIds = dupes.map((d) => d.id);

    console.log(`[productCategory] tenant=${tenantId} name=${k} canonical=${canonical.id} dupes=${dupes.length}`);
    if (dryRun) continue;

    // parentId is string-based; keep the hierarchy stable by remapping parentId pointers.
    await prisma.productCategory.updateMany({
      where: { tenantId, parentId: { in: dupIds }, deletedAt: null },
      data: { parentId: canonical.id },
    });

    await prisma.productCategory.updateMany({
      where: { id: { in: dupIds }, tenantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }
}

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: { code: { in: tenantCodes } },
    select: { id: true, code: true },
  });
  const byCode = new Map(tenants.map((t) => [t.code, t]));
  for (const code of tenantCodes) {
    if (!byCode.has(code)) throw new Error(`Missing tenant ${code}`);
  }

  for (const code of tenantCodes) {
    const tenantId = byCode.get(code)!.id;
    console.log(`\n=== Consolidating tenant ${code} (${tenantId}) ===`);
    await processPaymentAccounts(tenantId);
    await processExpenseCategories(tenantId);
    await processBrands(tenantId);
    await processProductCategories(tenantId);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

