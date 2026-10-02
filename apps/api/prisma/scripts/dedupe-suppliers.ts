/**
 * Merge duplicate Supplier rows (VM+VMS into VA CO2/CO3 pairs, doubled names).
 *
 * Grouping (per tenant), safest-first:
 *  1. Same normalized name + same legacy stem (legacyId % 10_000_000)
 *  2. Same normalized name + same meaningful phone
 *  3. Orphan with empty/nil phone attaches only if that name has exactly one cluster
 *
 * Distinct same-name contacts (e.g. KINGSLEY 00031 vs 00032) stay separate.
 *
 * Usage (from apps/api):
 *   npx tsx prisma/scripts/dedupe-suppliers.ts
 *   npx tsx prisma/scripts/dedupe-suppliers.ts --execute
 *   TENANTS=VA,VW npx tsx prisma/scripts/dedupe-suppliers.ts --execute
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { Redis } from '@upstash/redis';
import type { TenantScopedPrisma } from '../../src/common/prisma/prisma.service';
import { refreshSupplierPurchaseRollups } from '../../src/common/utils/supplierRollups';

loadDotEnv(resolve(__dirname, '../../.env'));

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--execute');
const tenantFilter = (process.env.TENANTS ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const NIL_PHONES = new Set(['', 'nil', 'nill', 'n/a', 'na', '-', '--', 'null', 'none']);
const LEGACY_MOD = 10_000_000;

type SupplierRow = {
  id: string;
  tenantId: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  taxNumber: string | null;
  accountHolderName: string | null;
  bankName: string | null;
  bankBranch: string | null;
  bankCode: string | null;
  bankAccountNo: string | null;
  taxPayerId: string | null;
  status: string;
  openingBalance: Prisma.Decimal;
  totalPurchase: Prisma.Decimal;
  totalPurchaseDue: Prisma.Decimal;
  totalPurchasePaid: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
};

type Enriched = SupplierRow & {
  legacyIds: number[];
  stems: number[];
  normName: string;
  normPhone: string | null;
};

type Cluster = {
  tenantId: string;
  key: string;
  members: Enriched[];
  keeper: Enriched;
  losers: Enriched[];
};

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
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    if (process.env[key]) continue;
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function undoubleName(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  const parts = collapsed.split(' ');
  if (parts.length >= 2 && parts.length % 2 === 0) {
    const half = parts.length / 2;
    const a = parts.slice(0, half).join(' ');
    const b = parts.slice(half).join(' ');
    if (a.toLowerCase() === b.toLowerCase()) return a;
  }
  return collapsed;
}

function normalizeName(raw: string): string {
  return undoubleName(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (NIL_PHONES.has(trimmed)) return null;
  const digits = trimmed.replace(/\D+/g, '');
  if (digits.length < 6) return null;
  return digits.replace(/^0+/, '') || digits;
}

function toNum(value: Prisma.Decimal | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  return Number(value.toString());
}

function isFilled(value: string | null | undefined): boolean {
  if (!value) return false;
  return !NIL_PHONES.has(value.trim().toLowerCase());
}

function richness(row: SupplierRow): number {
  return [
    row.contactName,
    row.email,
    row.phone,
    row.address,
    row.notes,
    row.taxNumber,
    row.accountHolderName,
    row.bankName,
    row.bankBranch,
    row.bankCode,
    row.bankAccountNo,
    row.taxPayerId,
  ].filter((v) => isFilled(v)).length;
}

function purchaseScore(row: SupplierRow): number {
  return (
    toNum(row.totalPurchase) +
    toNum(row.totalPurchasePaid) +
    toNum(row.totalPurchaseDue)
  );
}

function pickKeeper(members: Enriched[]): Enriched {
  return [...members].sort((a, b) => {
    const purchase = purchaseScore(b) - purchaseScore(a);
    if (purchase !== 0) return purchase;
    const rich = richness(b) - richness(a);
    if (rich !== 0) return rich;
    const phone = Number(Boolean(b.normPhone)) - Number(Boolean(a.normPhone));
    if (phone !== 0) return phone;
    const created = a.createdAt.getTime() - b.createdAt.getTime();
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  })[0];
}

function firstFilled(
  keeper: string | null,
  losers: Array<string | null>,
): string | null {
  if (isFilled(keeper)) return keeper;
  for (const value of losers) {
    if (isFilled(value)) return value;
  }
  return keeper;
}

function coalesceContactName(
  name: string,
  keeper: string | null,
  losers: Array<string | null>,
): string | null {
  const picked = firstFilled(keeper, losers);
  if (!picked) return null;
  if (normalizeName(picked) === normalizeName(name)) return null;
  return picked.trim();
}

function buildClusters(rows: Enriched[]): Cluster[] {
  const assigned = new Set<string>();
  const clusters: Cluster[] = [];

  const stemBuckets = new Map<string, Enriched[]>();
  for (const row of rows) {
    for (const stem of new Set(row.stems)) {
      const key = `${row.tenantId}::${row.normName}::stem:${stem}`;
      const bucket = stemBuckets.get(key) ?? [];
      bucket.push(row);
      stemBuckets.set(key, bucket);
    }
  }
  for (const [key, members] of stemBuckets) {
    const unique = dedupeMembers(members);
    if (unique.length < 2) continue;
    const cluster = toCluster(key, unique);
    clusters.push(cluster);
    for (const member of cluster.members) assigned.add(member.id);
  }

  const phoneBuckets = new Map<string, Enriched[]>();
  for (const row of rows) {
    if (assigned.has(row.id) || !row.normPhone) continue;
    const key = `${row.tenantId}::${row.normName}::phone:${row.normPhone}`;
    const bucket = phoneBuckets.get(key) ?? [];
    bucket.push(row);
    phoneBuckets.set(key, bucket);
  }
  for (const [key, members] of phoneBuckets) {
    const unique = dedupeMembers(members);
    if (unique.length < 2) continue;
    const cluster = toCluster(key, unique);
    clusters.push(cluster);
    for (const member of cluster.members) assigned.add(member.id);
  }

  const clustersByName = new Map<string, Cluster[]>();
  for (const cluster of clusters) {
    const nameKey = `${cluster.tenantId}::${cluster.keeper.normName}`;
    const list = clustersByName.get(nameKey) ?? [];
    list.push(cluster);
    clustersByName.set(nameKey, list);
  }
  for (const row of rows) {
    if (assigned.has(row.id) || row.normPhone) continue;
    const nameKey = `${row.tenantId}::${row.normName}`;
    const matches = clustersByName.get(nameKey) ?? [];
    if (matches.length !== 1) continue;
    const cluster = matches[0];
    cluster.members.push(row);
    cluster.keeper = pickKeeper(cluster.members);
    cluster.losers = cluster.members.filter((member) => member.id !== cluster.keeper.id);
    assigned.add(row.id);
  }

  return clusters.filter((cluster) => cluster.losers.length > 0);
}

function dedupeMembers(members: Enriched[]): Enriched[] {
  const seen = new Set<string>();
  const out: Enriched[] = [];
  for (const member of members) {
    if (seen.has(member.id)) continue;
    seen.add(member.id);
    out.push(member);
  }
  return out;
}

function toCluster(key: string, members: Enriched[]): Cluster {
  const keeper = pickKeeper(members);
  return {
    tenantId: members[0].tenantId,
    key,
    members,
    keeper,
    losers: members.filter((row) => row.id !== keeper.id),
  };
}

async function retarget(keeperId: string, loserIds: string[]): Promise<void> {
  await prisma.stockMovement.updateMany({
    where: { supplierId: { in: loserIds } },
    data: { supplierId: keeperId },
  });
  await prisma.invoice.updateMany({
    where: { supplierId: { in: loserIds } },
    data: { supplierId: keeperId },
  });
  await prisma.jobMaterial.updateMany({
    where: { supplierId: { in: loserIds } },
    data: { supplierId: keeperId },
  });
  await prisma.saleLine.updateMany({
    where: { supplierId: { in: loserIds } },
    data: { supplierId: keeperId },
  });
  await prisma.migrationLegacyId.updateMany({
    where: { entityType: 'supplier', newId: { in: loserIds } },
    data: { newId: keeperId },
  });
}

async function mergeKeeper(cluster: Cluster): Promise<void> {
  const { keeper, losers } = cluster;
  const name = undoubleName(keeper.name);
  const data: Prisma.SupplierUpdateInput = {
    name,
    contactName: coalesceContactName(
      name,
      keeper.contactName,
      losers.map((row) => row.contactName),
    ),
    email: firstFilled(
      keeper.email,
      losers.map((row) => row.email),
    ),
    phone: firstFilled(
      keeper.phone,
      losers.map((row) => row.phone),
    ),
    address: firstFilled(
      keeper.address,
      losers.map((row) => row.address),
    ),
    notes: firstFilled(
      keeper.notes,
      losers.map((row) => row.notes),
    ),
    taxNumber: firstFilled(
      keeper.taxNumber,
      losers.map((row) => row.taxNumber),
    ),
    accountHolderName: firstFilled(
      keeper.accountHolderName,
      losers.map((row) => row.accountHolderName),
    ),
    bankName: firstFilled(
      keeper.bankName,
      losers.map((row) => row.bankName),
    ),
    bankBranch: firstFilled(
      keeper.bankBranch,
      losers.map((row) => row.bankBranch),
    ),
    bankCode: firstFilled(
      keeper.bankCode,
      losers.map((row) => row.bankCode),
    ),
    bankAccountNo: firstFilled(
      keeper.bankAccountNo,
      losers.map((row) => row.bankAccountNo),
    ),
    taxPayerId: firstFilled(
      keeper.taxPayerId,
      losers.map((row) => row.taxPayerId),
    ),
    status:
      keeper.status === 'active' || losers.some((row) => row.status === 'active')
        ? 'active'
        : keeper.status,
  };
  await prisma.supplier.update({ where: { id: keeper.id }, data });
}

async function bustSupplierCaches(tenantIds: string[]): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.log('Skipping cache bust (Upstash env not loaded).');
    return;
  }
  const redis = new Redis({ url, token });
  for (const tenantId of tenantIds) {
    const verKey = `cacheVer:${tenantId}`;
    const epochKey = `listEpoch:${tenantId}`;
    const listKey = `listVer:${tenantId}:suppliers`;
    const [ver, epoch, listv] = await Promise.all([
      redis.get<number>(verKey),
      redis.get<number>(epochKey),
      redis.get<number>(listKey),
    ]);
    await Promise.all([
      redis.set(verKey, (Number(ver) || 1) + 1, { ex: 60 * 60 * 24 * 30 }),
      redis.set(epochKey, (Number(epoch) || 1) + 1, { ex: 60 * 60 * 24 * 30 }),
      redis.set(listKey, (Number(listv) || 1) + 1, { ex: 60 * 60 * 24 * 30 }),
    ]);
    console.log(`Busted supplier/list cache for ${tenantId}`);
  }
}

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: tenantFilter.length ? { code: { in: tenantFilter } } : undefined,
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });

  console.log(
    dryRun
      ? 'Dry-run — no writes. Re-run with --execute to apply.'
      : 'EXECUTE — merging duplicate suppliers.',
  );

  const nameFixes: Array<{ id: string; from: string; to: string }> = [];
  const allClusters: Cluster[] = [];

  for (const tenant of tenants) {
    const suppliers = await prisma.supplier.findMany({
      where: { tenantId: tenant.id, deletedAt: null },
    });
    const ids = suppliers.map((row) => row.id);
    const legacyRows =
      ids.length === 0
        ? []
        : await prisma.migrationLegacyId.findMany({
            where: {
              tenantId: tenant.id,
              entityType: 'supplier',
              newId: { in: ids },
            },
            select: { newId: true, legacyId: true },
          });
    const legacyByNewId = new Map<string, number[]>();
    for (const row of legacyRows) {
      const list = legacyByNewId.get(row.newId) ?? [];
      list.push(row.legacyId);
      legacyByNewId.set(row.newId, list);
    }

    const enriched: Enriched[] = suppliers.map((row) => {
      const legacyIds = legacyByNewId.get(row.id) ?? [];
      return {
        ...row,
        legacyIds,
        stems: legacyIds.map((id) => id % LEGACY_MOD),
        normName: normalizeName(row.name),
        normPhone: normalizePhone(row.phone),
      };
    });

    for (const row of enriched) {
      const cleaned = undoubleName(row.name);
      if (cleaned !== row.name) {
        nameFixes.push({ id: row.id, from: row.name, to: cleaned });
      }
    }

    const clusters = buildClusters(enriched);
    allClusters.push(...clusters);
    console.log(
      `${tenant.code}: ${suppliers.length} active, ${clusters.length} merge groups, ${nameFixes.filter((fix) => suppliers.some((row) => row.id === fix.id)).length} doubled names`,
    );
  }

  const sample = allClusters.slice(0, 25).map((cluster) => ({
    tenantId: cluster.tenantId,
    name: undoubleName(cluster.keeper.name),
    keeper: cluster.keeper.id,
    losers: cluster.losers.map((row) => row.id),
    stems: [...new Set(cluster.members.flatMap((row) => row.stems))],
    phones: [...new Set(cluster.members.map((row) => row.phone).filter(Boolean))],
    purchases: cluster.members.map((row) => Math.round(purchaseScore(row))),
  }));

  console.log(
    JSON.stringify(
      {
        mergeGroups: allClusters.length,
        rowsToSoftDelete: allClusters.reduce(
          (sum, cluster) => sum + cluster.losers.length,
          0,
        ),
        doubledNames: nameFixes.length,
        sample,
      },
      null,
      2,
    ),
  );

  if (dryRun) return;

  const now = new Date();
  const touchedTenants = new Set<string>();
  const keeperIds = new Set<string>();
  let merged = 0;
  let renamed = 0;

  for (const cluster of allClusters) {
    await retarget(cluster.keeper.id, cluster.losers.map((row) => row.id));
    await mergeKeeper(cluster);
    await prisma.supplier.updateMany({
      where: { id: { in: cluster.losers.map((row) => row.id) } },
      data: { deletedAt: now },
    });
    touchedTenants.add(cluster.tenantId);
    keeperIds.add(cluster.keeper.id);
    merged += 1;
    if (merged % 25 === 0) {
      console.log(`  merged ${merged}/${allClusters.length} groups`);
    }
  }

  const remainingNameFixes = nameFixes.filter((fix) => !keeperIds.has(fix.id));
  for (const fix of remainingNameFixes) {
    const stillActive = await prisma.supplier.findFirst({
      where: { id: fix.id, deletedAt: null },
      select: { id: true, tenantId: true },
    });
    if (!stillActive) continue;
    await prisma.supplier.update({
      where: { id: fix.id },
      data: { name: fix.to },
    });
    touchedTenants.add(stillActive.tenantId);
    renamed += 1;
  }

  console.log(`Refreshing rollups for ${keeperIds.size} keepers…`);
  let refreshed = 0;
  for (const id of keeperIds) {
    await refreshSupplierPurchaseRollups(
      prisma as unknown as TenantScopedPrisma,
      id,
    );
    refreshed += 1;
    if (refreshed % 25 === 0) {
      console.log(`  rollups ${refreshed}/${keeperIds.size}`);
    }
  }

  await bustSupplierCaches([...touchedTenants]);
  console.log(
    `Done. mergedGroups=${merged} softDeleted=${allClusters.reduce(
      (sum, cluster) => sum + cluster.losers.length,
      0,
    )} renamed=${renamed} rollups=${refreshed}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
