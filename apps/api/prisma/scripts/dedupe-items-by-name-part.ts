/**
 * Soft-delete near-duplicate Item rows that share the same display name and
 * the same leading OEM / part-number token in the SKU (within a tenant).
 *
 * Catches import clones where SKU application text differs slightly
 * (spacing, extra models) but the product shown in the list is identical.
 *
 * Keeper: highest quantity, then priced row, then newest createdAt.
 * Quantities of dropped rows are merged onto the keeper.
 *
 * Usage (from apps/api):
 *   npx tsx prisma/scripts/dedupe-items-by-name-part.ts
 *   npx tsx prisma/scripts/dedupe-items-by-name-part.ts --execute
 *   TENANTS=VISP,VSP,VP,VW,VA npx tsx prisma/scripts/dedupe-items-by-name-part.ts --execute
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

function normSku(s: string): string {
  return s
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s*,\s*/g, ',')
    .trim();
}

/** First OEM-ish token that contains a digit (min length 4). */
function leadingPart(sku: string): string | null {
  const n = normSku(sku);
  for (const token of n.split(/[\s,]+/).slice(0, 4)) {
    const cleaned = token.replace(/[^A-Z0-9-]/g, '');
    if (/\d/.test(cleaned) && cleaned.length >= 4) return cleaned;
  }
  return null;
}

type Row = {
  id: string;
  name: string;
  sku: string;
  quantity: number;
  sellPrice: number | null;
  createdAt: Date;
};

type DupGroup = {
  key: string;
  rows: Row[];
};

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
    const part = leadingPart(r.sku);
    if (!part) continue;
    const key = `${r.name.trim().toLowerCase()}||${part}`;
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
    .map(([key, list]) => ({
      key,
      rows: list.sort((a, b) => {
        if (b.quantity !== a.quantity) return b.quantity - a.quantity;
        const ap = a.sellPrice == null ? 0 : 1;
        const bp = b.sellPrice == null ? 0 : 1;
        if (bp !== ap) return bp - ap;
        return b.createdAt.getTime() - a.createdAt.getTime();
      }),
    }));
}

async function dedupeTenant(tenantId: string, code: string): Promise<void> {
  const groups = await loadGroups(tenantId);
  const extras = groups.reduce((n, g) => n + g.rows.length - 1, 0);
  console.log(
    `\n${code}: ${groups.length} name+part group(s), ${extras} extra row(s)`,
  );
  for (const g of groups.slice(0, 6)) {
    const keeper = g.rows[0]!;
    console.log(
      `  ${g.key.slice(0, 72)} → keep qty ${keeper.quantity}` +
        (keeper.sellPrice != null ? ` @${keeper.sellPrice}` : '') +
        `, drop ${g.rows.length - 1}`,
    );
  }
  if (groups.length > 6) console.log(`  … +${groups.length - 6} more`);

  if (dryRun || groups.length === 0) return;

  let merged = 0;
  let softDeleted = 0;
  for (const g of groups) {
    const keeper = g.rows[0]!;
    const drops = g.rows.slice(1);
    const addQty = drops.reduce((n, r) => n + r.quantity, 0);
    if (addQty > 0) {
      await prisma.item.update({
        where: { id: keeper.id },
        data: {
          quantity: keeper.quantity + addQty,
          ...(keeper.sellPrice == null
            ? {
                sellPrice:
                  drops.find((d) => d.sellPrice != null)?.sellPrice ??
                  undefined,
              }
            : {}),
        },
      });
      merged += 1;
    } else if (keeper.sellPrice == null) {
      const priced = drops.find((d) => d.sellPrice != null);
      if (priced) {
        await prisma.item.update({
          where: { id: keeper.id },
          data: { sellPrice: priced.sellPrice },
        });
      }
    }
    const result = await prisma.item.updateMany({
      where: { id: { in: drops.map((d) => d.id) }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    softDeleted += result.count;
  }

  const active = await prisma.item.count({
    where: { tenantId, deletedAt: null },
  });
  console.log({ code, qtyMergedKeepers: merged, softDeleted, activeItems: active });
}

async function main() {
  console.log(
    dryRun
      ? 'DRY RUN (pass --execute to soft-delete name+part duplicates)'
      : 'EXECUTE — merging qty and soft-deleting name+part duplicates',
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

  if (dryRun) {
    console.log('\nRe-run with --execute to apply.');
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
