/**
 * Soft-delete Item rows whose SKUs match after stripping all non-alphanumeric
 * characters (within a tenant). Catches clones like:
 *   "OIL FILTER 06E 115562B …" vs "OIL FILTER 06E115562B …"
 *   "SAND PAPER P800" vs "SANDPAPER P800"
 *   "18847-11160 …" vs "1884711160 …"
 *
 * Keeper: highest quantity, then priced row, then newest createdAt.
 * Dropped quantities are merged onto the keeper.
 *
 * Usage (from apps/api):
 *   npx tsx prisma/scripts/dedupe-items-by-compact-sku.ts
 *   TENANTS=VISP,VSP,VP,VW,VA npx tsx prisma/scripts/dedupe-items-by-compact-sku.ts --execute
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';

loadDotEnv(resolve(__dirname, '../../.env'));

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--execute');
const tenantFilter = (process.env.TENANTS ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/** Min compact length — avoid collapsing short SKUs like "H9". */
const MIN_COMPACT_LEN = 8;

function loadDotEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
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
}

function compactSku(sku: string): string {
  return sku.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

type Row = {
  id: string;
  name: string;
  sku: string;
  quantity: number;
  sellPrice: number | null;
  createdAt: Date;
};

type DupGroup = { key: string; rows: Row[] };

function rankRows(list: Row[]): Row[] {
  return [...list].sort((a, b) => {
    if (b.quantity !== a.quantity) return b.quantity - a.quantity;
    const ap = a.sellPrice == null ? 0 : 1;
    const bp = b.sellPrice == null ? 0 : 1;
    if (bp !== ap) return bp - ap;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

async function loadGroups(tenantId: string): Promise<DupGroup[]> {
  const rows = await prisma.item.findMany({
    where: { tenantId, deletedAt: null },
    select: {
      id: true,
      name: true,
      sku: true,
      quantity: true,
      sellPrice: true,
      createdAt: true,
    },
  });

  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const key = compactSku(r.sku);
    if (key.length < MIN_COMPACT_LEN) continue;
    const list = map.get(key) ?? [];
    list.push({
      id: r.id,
      name: r.name,
      sku: r.sku,
      quantity: Number(r.quantity),
      sellPrice: r.sellPrice == null ? null : Number(r.sellPrice),
      createdAt: r.createdAt,
    });
    map.set(key, list);
  }

  return [...map.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, rows: rankRows(list) }));
}

async function dedupeTenant(tenantId: string, code: string): Promise<void> {
  const groups = await loadGroups(tenantId);
  const extras = groups.reduce((n, g) => n + g.rows.length - 1, 0);
  console.log(
    `\n${code}: ${groups.length} compact-SKU group(s), ${extras} extra row(s)`,
  );
  for (const g of groups.slice(0, 6)) {
    const keeper = g.rows[0]!;
    console.log(
      `  ${g.key.slice(0, 48)} → keep qty ${keeper.quantity}, drop ${g.rows.length - 1}`,
    );
    for (const r of g.rows.slice(0, 3)) {
      console.log(`    ${r.sku.slice(0, 72)}`);
    }
  }
  if (groups.length > 6) console.log(`  … +${groups.length - 6} more`);

  if (dryRun || groups.length === 0) return;

  const now = new Date();
  let softDeleted = 0;
  let qtyMergedKeepers = 0;

  // Batch soft-deletes; qty merges stay per-keeper (smaller set).
  const dropIds: string[] = [];
  for (const g of groups) {
    const keeper = g.rows[0]!;
    const drops = g.rows.slice(1);
    const addQty = drops.reduce((n, r) => n + r.quantity, 0);
    const priced =
      keeper.sellPrice == null
        ? drops.find((d) => d.sellPrice != null)?.sellPrice
        : undefined;
    if (addQty > 0 || priced != null) {
      await prisma.item.update({
        where: { id: keeper.id },
        data: {
          ...(addQty > 0 ? { quantity: keeper.quantity + addQty } : {}),
          ...(priced != null ? { sellPrice: priced } : {}),
        },
      });
      qtyMergedKeepers += 1;
    }
    dropIds.push(...drops.map((d) => d.id));
  }

  const CHUNK = 100;
  for (let i = 0; i < dropIds.length; i += CHUNK) {
    const chunk = dropIds.slice(i, i + CHUNK);
    const result = await prisma.item.updateMany({
      where: { id: { in: chunk }, deletedAt: null },
      data: { deletedAt: now },
    });
    softDeleted += result.count;
  }

  const active = await prisma.item.count({
    where: { tenantId, deletedAt: null },
  });
  console.log({ code, qtyMergedKeepers, softDeleted, activeItems: active });
}

async function main() {
  console.log(
    dryRun
      ? 'DRY RUN (pass --execute to soft-delete compact-SKU duplicates)'
      : 'EXECUTE — merging qty and soft-deleting compact-SKU duplicates',
  );

  const tenants = await prisma.tenant.findMany({
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });
  const selected = tenantFilter.length
    ? tenants.filter((t) => tenantFilter.includes(t.code.toUpperCase()))
    : tenants;
  if (selected.length === 0) {
    throw new Error(
      tenantFilter.length
        ? `No tenants matched TENANTS=${tenantFilter.join(',')}`
        : 'No tenants found',
    );
  }

  for (const t of selected) {
    await dedupeTenant(t.id, t.code);
  }

  if (dryRun) console.log('\nRe-run with --execute to apply.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
