/**
 * Soft-delete name-as-SKU import clones (SKU === product name) when a
 * "Vonos auto-*" twin exists for the same display name.
 *
 * Does NOT merge multiple Vonos-auto OT lines that share a label (e.g. labour).
 * Those stay as separate SKUs.
 *
 * AC STOP LEAK example:
 *   sku "AC STOP LEAK" + sku "Vonos auto-6578" → one row (qty merged).
 *
 * Usage (from apps/api):
 *   npx tsx prisma/scripts/dedupe-items-name-clones.ts
 *   TENANTS=VISP,VSP,VP,VW,VA npx tsx prisma/scripts/dedupe-items-name-clones.ts --execute
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

type Row = {
  id: string;
  name: string;
  sku: string;
  quantity: number;
  costPrice: number | null;
  sellPrice: number | null;
  createdAt: Date;
};

type MergePlan = { keeper: Row; drops: Row[] };

function isNameAsSku(name: string, sku: string): boolean {
  return sku.trim().toLowerCase() === name.trim().toLowerCase();
}

function isVonosAutoSku(sku: string): boolean {
  return /^vonos\s*auto[-_\s]?\d+/i.test(sku.trim());
}

function rank(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if (b.quantity !== a.quantity) return b.quantity - a.quantity;
    const ap = a.sellPrice == null ? 0 : 1;
    const bp = b.sellPrice == null ? 0 : 1;
    if (bp !== ap) return bp - ap;
    const ac = a.costPrice == null ? 0 : 1;
    const bc = b.costPrice == null ? 0 : 1;
    if (bc !== ac) return bc - ac;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

function planMerge(rows: Row[]): MergePlan | null {
  const nameAsSku = rows.filter((r) => isNameAsSku(r.name, r.sku));
  const vonos = rows.filter((r) => isVonosAutoSku(r.sku));

  // Exact duplicate name-as-SKU rows only.
  if (nameAsSku.length >= 2 && vonos.length === 0) {
    const ranked = rank(nameAsSku);
    return { keeper: ranked[0]!, drops: ranked.slice(1) };
  }

  if (nameAsSku.length === 0 || vonos.length === 0) return null;

  // One Vonos-auto twin: fold name-as-SKU (+ that twin) into a single product.
  if (vonos.length === 1) {
    const ranked = rank([...nameAsSku, ...vonos]);
    const keeper = ranked[0]!;
    return {
      keeper,
      drops: ranked.filter((r) => r.id !== keeper.id),
    };
  }

  // Several Vonos-auto OT lines share the label — only remove name-as-SKU clones.
  const keeper = rank([...vonos, ...nameAsSku])[0]!;
  const drops = nameAsSku.filter((r) => r.id !== keeper.id);
  if (drops.length === 0) return null;
  return { keeper, drops };
}

async function loadPlans(tenantId: string): Promise<MergePlan[]> {
  const rows = await prisma.item.findMany({
    where: { tenantId, deletedAt: null },
    select: {
      id: true,
      name: true,
      sku: true,
      quantity: true,
      costPrice: true,
      sellPrice: true,
      createdAt: true,
    },
  });

  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push({
      id: r.id,
      name: r.name,
      sku: r.sku,
      quantity: Number(r.quantity),
      costPrice: r.costPrice == null ? null : Number(r.costPrice),
      sellPrice: r.sellPrice == null ? null : Number(r.sellPrice),
      createdAt: r.createdAt,
    });
    map.set(key, list);
  }

  const plans: MergePlan[] = [];
  for (const list of map.values()) {
    if (list.length < 2) continue;
    const plan = planMerge(list);
    if (plan && plan.drops.length > 0) plans.push(plan);
  }
  return plans;
}

async function applyPlan(plan: MergePlan): Promise<{ merged: boolean; softDeleted: number }> {
  const { keeper, drops } = plan;
  const addQty = drops.reduce((n, r) => n + r.quantity, 0);
  const sell =
    keeper.sellPrice ??
    drops.find((d) => d.sellPrice != null)?.sellPrice ??
    undefined;
  const cost =
    keeper.costPrice ??
    drops.find((d) => d.costPrice != null)?.costPrice ??
    undefined;
  const betterSku =
    isNameAsSku(keeper.name, keeper.sku)
      ? drops.find((d) => isVonosAutoSku(d.sku))?.sku
      : undefined;

  const patch: {
    quantity?: number;
    sellPrice?: number;
    costPrice?: number;
    sku?: string;
  } = {};
  if (addQty > 0) patch.quantity = keeper.quantity + addQty;
  if (keeper.sellPrice == null && sell != null) patch.sellPrice = sell;
  if (keeper.costPrice == null && cost != null) patch.costPrice = cost;
  if (betterSku) patch.sku = betterSku;

  let merged = false;
  if (Object.keys(patch).length > 0) {
    await prisma.item.update({ where: { id: keeper.id }, data: patch });
    merged = true;
  }

  const result = await prisma.item.updateMany({
    where: { id: { in: drops.map((d) => d.id) }, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return { merged, softDeleted: result.count };
}

async function dedupeTenant(tenantId: string, code: string): Promise<void> {
  const plans = await loadPlans(tenantId);
  const extras = plans.reduce((n, p) => n + p.drops.length, 0);
  console.log(
    `\n${code}: ${plans.length} name-clone plan(s), ${extras} extra row(s)`,
  );
  for (const p of plans.slice(0, 8)) {
    console.log(
      `  "${p.keeper.name}" → keep sku=${p.keeper.sku.slice(0, 40)} qty=${p.keeper.quantity}, drop ${p.drops.length}`,
    );
    for (const r of p.drops.slice(0, 3)) {
      console.log(`    drop sku=${r.sku.slice(0, 40)} qty=${r.quantity}`);
    }
  }
  if (plans.length > 8) console.log(`  … +${plans.length - 8} more`);

  if (dryRun || plans.length === 0) return;

  let softDeleted = 0;
  let qtyMergedKeepers = 0;
  for (const p of plans) {
    const result = await applyPlan(p);
    softDeleted += result.softDeleted;
    if (result.merged) qtyMergedKeepers += 1;
  }

  const active = await prisma.item.count({
    where: { tenantId, deletedAt: null },
  });
  console.log({ code, qtyMergedKeepers, softDeleted, activeItems: active });
}

async function main() {
  console.log(
    dryRun
      ? 'DRY RUN (pass --execute to soft-delete name-clone duplicates)'
      : 'EXECUTE — merging qty and soft-deleting name-clone duplicates',
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
