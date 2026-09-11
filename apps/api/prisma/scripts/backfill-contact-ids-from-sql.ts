/**
 * Backfill Customer.details.contactId across all tenants.
 *
 * Resolution order (per tenant, joined via MigrationLegacyId):
 *   1. Legacy contacts.contact_id if it's a real plate / manual value
 *      (non-empty and NOT an auto CO000x / CU000x).
 *   2. Plate from the customer's linked Job -> Vehicle.plateNumber
 *      (fallback: plate pattern in Job.customerName / Customer.name).
 *   3. The legacy CO000x value if present.
 *   4. Generated CU000x from the (un-offset) legacy id.
 *
 * The legacy contact_id map is produced by:
 *   python3 scripts/migration/extract_contact_ids.py
 * which writes tmp/legacy_contact_ids_by_tenant.json keyed by MigrationLegacyId.legacyId.
 *
 * Usage:
 *   npx tsx prisma/scripts/backfill-contact-ids-from-sql.ts --dry-run
 *   npx tsx prisma/scripts/backfill-contact-ids-from-sql.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");
const MAP_PATH =
  process.env.CONTACT_ID_MAP ??
  resolve(process.cwd(), "../../tmp/legacy_contact_ids_by_tenant.json");

// VA composite offsets (must match scripts/migration_registry.py).
const OFFSETS = {
  ops: 10_000_000,
  hq3: 20_000_000,
  hq2: 30_000_000,
} as const;

const PLATE_IN_NAME_RE = /\b([A-Z]{1,4}-[A-Z0-9]{1,8})\b/i;
// Auto-generated Ultimate POS contact ids we treat as "not a real" identifier.
const AUTO_CONTACT_ID_RE = /^C[OU]\d+$/i;

function rawLegacyId(legacyId: number): number {
  if (legacyId >= OFFSETS.hq2) return legacyId - OFFSETS.hq2;
  if (legacyId >= OFFSETS.hq3) return legacyId - OFFSETS.hq3;
  if (legacyId >= OFFSETS.ops) return legacyId - OFFSETS.ops;
  return legacyId;
}

function plateFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const m = name.match(PLATE_IN_NAME_RE);
  return m?.[1]?.toUpperCase() ?? null;
}

function isRealContactId(value: string | null | undefined): value is string {
  const v = (value ?? "").trim();
  return v.length > 0 && !AUTO_CONTACT_ID_RE.test(v);
}

function generatedContactId(legacyId: number): string {
  return `CU${String(rawLegacyId(legacyId)).padStart(4, "0")}`;
}

/** Load { tenantId: { legacyId: contact_id } } from the extractor output. */
function loadTenantMap(): Map<string, Map<number, string>> {
  const map = new Map<string, Map<number, string>>();
  if (!existsSync(MAP_PATH)) {
    console.warn(
      `Contact ID map missing: ${MAP_PATH}\nRun: python3 scripts/migration/extract_contact_ids.py`,
    );
    return map;
  }
  const raw = JSON.parse(readFileSync(MAP_PATH, "utf8")) as {
    byTenant?: Record<string, Record<string, string>>;
  };
  for (const [tenantId, entries] of Object.entries(raw.byTenant ?? {})) {
    const inner = new Map<number, string>();
    for (const [k, v] of Object.entries(entries)) {
      const id = Number.parseInt(k, 10);
      if (Number.isFinite(id) && v.trim()) inner.set(id, v.trim());
    }
    map.set(tenantId, inner);
  }
  return map;
}

/** customerId -> plate, resolved from the most recent linked job/vehicle. */
async function buildPlateByCustomer(): Promise<Map<string, string>> {
  const vehicles = await prisma.vehicle.findMany({
    where: { deletedAt: null },
    select: { id: true, plateNumber: true },
  });
  const plateByVehicle = new Map(
    vehicles.map((v) => [v.id, v.plateNumber?.trim().toUpperCase() ?? ""]),
  );

  const jobs = await prisma.job.findMany({
    where: { deletedAt: null, customerId: { not: null } },
    select: {
      customerId: true,
      customerName: true,
      vehicleId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const byCustomer = new Map<string, string>();
  for (const job of jobs) {
    if (!job.customerId) continue;
    const fromVehicle = job.vehicleId
      ? plateByVehicle.get(job.vehicleId) || null
      : null;
    const plate = fromVehicle || plateFromName(job.customerName);
    if (plate) byCustomer.set(job.customerId, plate); // asc order => keeps latest
  }
  return byCustomer;
}

async function main() {
  console.log(DRY_RUN ? "DRY RUN" : "WRITE");
  console.log(`Map: ${MAP_PATH}`);
  const tenantMap = loadTenantMap();
  const totalSqlIds = [...tenantMap.values()].reduce((n, m) => n + m.size, 0);
  console.log(`SQL contact_ids: ${totalSqlIds} across ${tenantMap.size} tenants`);

  const plateByCustomer = await buildPlateByCustomer();
  console.log(`Customers with a job/vehicle plate: ${plateByCustomer.size}`);

  const legacyRows = await prisma.migrationLegacyId.findMany({
    where: { entityType: "customer" },
    select: { tenantId: true, legacyId: true, newId: true },
  });
  console.log(`MigrationLegacyId customers: ${legacyRows.length}`);

  const customers = await prisma.customer.findMany({
    where: { deletedAt: null },
    select: { id: true, tenantId: true, name: true, phone: true, details: true },
  });
  const customerById = new Map(customers.map((c) => [c.id, c]));

  type Patch = {
    id: string;
    tenantId: string;
    contactId: string;
    source: string;
  };
  const patches: Patch[] = [];
  let already = 0;
  let missingCustomer = 0;

  const patchedIds = new Set<string>();

  for (const row of legacyRows) {
    const customer = customerById.get(row.newId);
    if (!customer) {
      missingCustomer += 1;
      continue;
    }
    const details =
      customer.details && typeof customer.details === "object"
        ? (customer.details as Record<string, unknown>)
        : {};
    const existing =
      typeof details.contactId === "string" ? details.contactId.trim() : "";
    // Never clobber a real, manually-entered value.
    if (isRealContactId(existing)) {
      already += 1;
      continue;
    }

    const sqlId = tenantMap.get(row.tenantId)?.get(row.legacyId) ?? null;
    const jobPlate = plateByCustomer.get(customer.id) ?? null;
    const namePlate = plateFromName(customer.name);

    // Order: real manual/plate id > linked job/vehicle plate > legacy CO000x >
    // weak name-regex plate > generated. Name-regex is last so noisy matches
    // (e.g. "MINI-COOPER") never override a real CO-series value.
    let contactId: string;
    let source: string;
    if (isRealContactId(sqlId)) {
      contactId = sqlId;
      source = "sql";
    } else if (jobPlate) {
      contactId = jobPlate;
      source = "job-vehicle";
    } else if (sqlId) {
      contactId = sqlId; // legacy CO000x
      source = "sql-legacy";
    } else if (namePlate) {
      contactId = namePlate;
      source = "name";
    } else {
      contactId = generatedContactId(row.legacyId);
      source = "generated";
    }

    // Skip no-op (existing already equals the resolved value).
    if (existing && existing === contactId) {
      already += 1;
      continue;
    }

    patches.push({ id: customer.id, tenantId: customer.tenantId, contactId, source });
    patchedIds.add(customer.id);
  }

  // Non-migrated customers (no MigrationLegacyId row): fill from name plate only.
  for (const c of customers) {
    if (patchedIds.has(c.id)) continue;
    const details =
      c.details && typeof c.details === "object"
        ? (c.details as Record<string, unknown>)
        : {};
    const existing =
      typeof details.contactId === "string" ? details.contactId.trim() : "";
    if (isRealContactId(existing)) {
      already += 1;
      continue;
    }
    const fromName = plateFromName(c.name);
    if (!fromName || fromName === existing) continue;
    patches.push({
      id: c.id,
      tenantId: c.tenantId,
      contactId: fromName,
      source: "name-only",
    });
    patchedIds.add(c.id);
  }

  const bySource = patches.reduce(
    (acc, p) => {
      acc[p.source] = (acc[p.source] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  console.log({
    patches: patches.length,
    alreadyHadContactId: already,
    missingCustomer,
    bySource,
    sample: patches.slice(0, 15),
  });

  if (DRY_RUN || patches.length === 0) {
    console.log("Done (no writes).");
    return;
  }

  const BATCH = 400;
  let updated = 0;
  for (let i = 0; i < patches.length; i += BATCH) {
    const batch = patches.slice(i, i + BATCH);
    const values = Prisma.join(
      batch.map((p) => Prisma.sql`(${p.id}, ${p.contactId})`),
    );
    await prisma.$executeRaw`
      UPDATE "Customer" AS c
      SET details = COALESCE(c.details, '{}'::jsonb)
        || jsonb_build_object('contactId', v.contact_id)
      FROM (VALUES ${values}) AS v(id, contact_id)
      WHERE c.id = v.id
    `;
    updated += batch.length;
    console.log(`  updated ${updated}/${patches.length}`);
  }

  // Propagate by name+phone to peer tenant copies missing contactId.
  const keyed = new Map<string, string>();
  const refreshed = await prisma.customer.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, phone: true, details: true },
  });
  for (const c of refreshed) {
    const details = c.details as Record<string, unknown> | null;
    const cid =
      typeof details?.contactId === "string" ? details.contactId.trim() : "";
    if (!cid || !c.phone?.trim()) continue;
    const key = `${(c.name ?? "").trim().toLowerCase()}|${c.phone.trim()}`;
    if (!keyed.has(key)) keyed.set(key, cid);
  }

  let propagated = 0;
  const peerPatches: Array<{ id: string; contactId: string }> = [];
  for (const c of refreshed) {
    const details =
      c.details && typeof c.details === "object"
        ? (c.details as Record<string, unknown>)
        : {};
    const existing =
      typeof details.contactId === "string" ? details.contactId.trim() : "";
    if (existing || !c.phone?.trim()) continue;
    const key = `${(c.name ?? "").trim().toLowerCase()}|${c.phone.trim()}`;
    const cid = keyed.get(key);
    if (!cid) continue;
    peerPatches.push({ id: c.id, contactId: cid });
  }

  for (let i = 0; i < peerPatches.length; i += BATCH) {
    const batch = peerPatches.slice(i, i + BATCH);
    const values = Prisma.join(
      batch.map((p) => Prisma.sql`(${p.id}, ${p.contactId})`),
    );
    await prisma.$executeRaw`
      UPDATE "Customer" AS c
      SET details = COALESCE(c.details, '{}'::jsonb)
        || jsonb_build_object('contactId', v.contact_id)
      FROM (VALUES ${values}) AS v(id, contact_id)
      WHERE c.id = v.id
    `;
    propagated += batch.length;
  }
  console.log(`Propagated contactId to ${propagated} peer rows`);
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
