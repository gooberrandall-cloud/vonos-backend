/**
 * Backfill Sale.serviceStaffEmployeeId / cleanerName from legacy Ultimate POS.
 *
 * Why: historical staff assignment existed for a reason (who did the work /
 * commission attribution). Migration brought sales but left cleaner* empty.
 *
 * VA / hq3temp source of truth:
 *   transactions.res_waiter_id  (restaurant "waiter" field reused as workshop staff)
 * Sell-line fallback (Quotation/OPS-style dumps):
 *   transaction_sell_lines.res_service_staff_id
 *
 * Mapping:
 *   legacy transaction id + LEGACY_ID_OFFSET → MigrationLegacyId(sale)
 *   legacy user id → Employee.employeeCode, else name match, else create Employee
 *
 * Usage (from apps/api):
 *   TENANT_CODE=VA npx ts-node --transpile-only prisma/scripts/backfill-sale-service-staff-from-legacy.ts
 *   LEGACY_SQL=/path/to/localhost.sql LEGACY_DB=vonomglk_hq3temp TENANT_CODE=VA ...
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const tenantCode = (process.env.TENANT_CODE ?? 'VA').trim().toUpperCase();
const legacySql =
  process.env.LEGACY_SQL?.trim() ||
  path.resolve(process.cwd(), '../../localhost.sql');
const legacyDb =
  process.env.LEGACY_DB?.trim() ||
  (tenantCode === 'VA' ? 'vonomglk_hq3temp' : '');
/** HQ3 sales were stored with +20_000_000 on MigrationLegacyId.legacyId */
const legacyIdOffset = Number(
  process.env.LEGACY_ID_OFFSET ?? (tenantCode === 'VA' ? 20_000_000 : 0),
);
const BATCH = 250;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: string }).code)
          : '';
      if (code !== 'P2024' && code !== 'P1001') throw error;
      const waitMs = attempt * 2000;
      console.warn(`${label}: ${code}, retry ${attempt}/5 in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw last;
}

type StaffAgg = Map<number, number>; // staffId -> line count

function unescapeSql(value: string): string {
  return value.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function parseTupleFields(tuple: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < tuple.length; i++) {
    const ch = tuple[i]!;
    if (inStr) {
      if (ch === '\\' && i + 1 < tuple.length) {
        cur += ch + tuple[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === "'") {
        inStr = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      continue;
    }
    if (ch === ',') {
      fields.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}

function parseCreateColumns(createBlock: string[]): string[] {
  const cols: string[] = [];
  for (const line of createBlock) {
    const m = line.match(/^\s*`([^`]+)`/);
    if (m?.[1]) cols.push(m[1]);
  }
  return cols;
}

async function loadLegacyStaffByTransaction(): Promise<{
  byTx: Map<number, number>; // txId (raw MySQL) -> dominant staffId
  userNames: Map<number, string>;
  source: string;
}> {
  const lineStaffCounts = new Map<number, StaffAgg>();
  const waiterByTx = new Map<number, number>();
  const userNames = new Map<number, string>();

  let currentDb: string | null = null;
  let mode: 'none' | 'sell_lines' | 'transactions' | 'users' | 'create_tx' | 'create_lines' =
    'none';
  let createBuf: string[] = [];
  let txCols: string[] | null = null;
  let lineCols: string[] | null = null;

  const inScopeDb = (): boolean => {
    if (!legacyDb) return true;
    return currentDb === legacyDb;
  };

  const rl = createInterface({
    input: createReadStream(legacySql, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const useMatch = line.match(/^USE `([^`]+)`/);
    if (useMatch) {
      currentDb = useMatch[1] ?? null;
      mode = 'none';
      createBuf = [];
      continue;
    }

    if (!inScopeDb()) continue;

    if (line.startsWith('CREATE TABLE `transactions`')) {
      mode = 'create_tx';
      createBuf = [];
      continue;
    }
    if (line.startsWith('CREATE TABLE `transaction_sell_lines`')) {
      mode = 'create_lines';
      createBuf = [];
      continue;
    }
    if (mode === 'create_tx' || mode === 'create_lines') {
      createBuf.push(line);
      if (line.startsWith(')')) {
        const cols = parseCreateColumns(createBuf);
        if (mode === 'create_tx') txCols = cols;
        else lineCols = cols;
        mode = 'none';
        createBuf = [];
      }
      continue;
    }

    if (line.startsWith('INSERT INTO `transaction_sell_lines`')) {
      mode = 'sell_lines';
      continue;
    }
    if (line.startsWith('INSERT INTO `transactions`')) {
      mode = 'transactions';
      continue;
    }
    if (line.startsWith('INSERT INTO `users`')) {
      mode = 'users';
      continue;
    }
    if (line.startsWith('INSERT INTO `')) {
      mode = 'none';
      continue;
    }
    if (mode === 'none' || !line.startsWith('(')) continue;

    const trimmed = line.trim().replace(/,$/, '').replace(/;$/, '');
    if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) continue;
    const fields = parseTupleFields(trimmed.slice(1, -1));

    if (mode === 'transactions') {
      const typeIdx = txCols?.indexOf('type') ?? 7;
      const waiterIdx = txCols?.indexOf('res_waiter_id') ?? 5;
      if (fields.length <= Math.max(typeIdx, waiterIdx)) continue;
      const txType = fields[typeIdx]?.replace(/^'|'$/g, '');
      if (txType !== 'sell') continue;
      const txId = Number(fields[0]);
      const waiterRaw = fields[waiterIdx] ?? 'NULL';
      if (!Number.isFinite(txId)) continue;
      if (!waiterRaw || waiterRaw === 'NULL' || !/^[1-9]\d*$/.test(waiterRaw)) {
        continue;
      }
      waiterByTx.set(txId, Number(waiterRaw));
      continue;
    }

    if (mode === 'sell_lines') {
      const staffIdx = lineCols?.indexOf('res_service_staff_id') ?? 19;
      const txIdx = lineCols?.indexOf('transaction_id') ?? 1;
      if (fields.length <= Math.max(staffIdx, txIdx)) continue;
      const txId = Number(fields[txIdx]);
      if (!Number.isFinite(txId)) continue;

      let staffRaw = fields[staffIdx] ?? 'NULL';
      if (
        (staffRaw === 'NULL' || /^\d+\.\d+$/.test(staffRaw)) &&
        fields[staffIdx + 1] &&
        /^[1-9]\d*$/.test(fields[staffIdx + 1]!)
      ) {
        staffRaw = fields[staffIdx + 1]!;
      }
      if (!staffRaw || staffRaw === 'NULL' || !/^[1-9]\d*$/.test(staffRaw)) {
        continue;
      }
      const staffId = Number(staffRaw);
      const agg = lineStaffCounts.get(txId) ?? new Map<number, number>();
      agg.set(staffId, (agg.get(staffId) ?? 0) + 1);
      lineStaffCounts.set(txId, agg);
      continue;
    }

    if (mode === 'users') {
      const tuples = line.match(/\((?:[^()]|'[^']*')*\)/g) ?? [trimmed];
      for (const raw of tuples) {
        const uFields = parseTupleFields(raw.slice(1, -1));
        if (uFields.length < 5) continue;
        const uid = Number(uFields[0]);
        if (!Number.isFinite(uid)) continue;
        const surname = unescapeSql(uFields[2] ?? '');
        const first = unescapeSql(uFields[3] ?? '');
        const last = unescapeSql(uFields[4] ?? '');
        const name =
          [first, last].filter(Boolean).join(' ').trim() || surname.trim();
        if (name) userNames.set(uid, name);
      }
    }
  }

  const byTx = new Map<number, number>();
  for (const [txId, staffId] of waiterByTx) {
    byTx.set(txId, staffId);
  }
  for (const [txId, counts] of lineStaffCounts) {
    if (byTx.has(txId)) continue;
    let bestId = 0;
    let bestN = -1;
    for (const [staffId, n] of counts) {
      if (n > bestN) {
        bestN = n;
        bestId = staffId;
      }
    }
    if (bestId > 0) byTx.set(txId, bestId);
  }

  const source =
    waiterByTx.size > 0
      ? `res_waiter_id (${waiterByTx.size} sells)` +
        (lineStaffCounts.size
          ? ` + sell_lines (${lineStaffCounts.size} txs)`
          : '')
      : `sell_lines (${lineStaffCounts.size} txs)`;

  return { byTx, userNames, source };
}

type EmployeeRef = { id: string; name: string };

async function resolveEmployees(args: {
  tenantId: string;
  designationId: string;
  staffIds: number[];
  userNames: Map<number, string>;
}): Promise<{ byStaffId: Map<number, EmployeeRef>; created: number }> {
  const codes = args.staffIds.map(String);
  const existing = await prisma.employee.findMany({
    where: {
      tenantId: args.tenantId,
      deletedAt: null,
      OR: [
        { employeeCode: { in: codes } },
        {
          name: {
            in: args.staffIds
              .map((id) => args.userNames.get(id)?.trim())
              .filter((n): n is string => Boolean(n)),
            mode: 'insensitive',
          },
        },
      ],
    },
    select: {
      id: true,
      name: true,
      employeeCode: true,
      isServiceStaff: true,
    },
  });

  const byCode = new Map<string, (typeof existing)[number]>();
  const byName = new Map<string, (typeof existing)[number]>();
  for (const emp of existing) {
    if (emp.employeeCode) byCode.set(emp.employeeCode, emp);
    byName.set(emp.name.trim().toLowerCase(), emp);
  }

  const byStaffId = new Map<number, EmployeeRef>();
  const toMarkServiceStaff = new Set<string>();
  const toSetCode: Array<{ id: string; code: string }> = [];
  let created = 0;

  for (const staffId of args.staffIds) {
    const code = String(staffId);
    const name =
      args.userNames.get(staffId)?.trim() || `Legacy staff #${staffId}`;
    let emp = byCode.get(code) ?? byName.get(name.toLowerCase());

    if (!emp) {
      emp = await prisma.employee.create({
        data: {
          tenantId: args.tenantId,
          name,
          employeeCode: code,
          designationId: args.designationId,
          isServiceStaff: true,
        },
        select: {
          id: true,
          name: true,
          employeeCode: true,
          isServiceStaff: true,
        },
      });
      created += 1;
      byCode.set(code, emp);
      byName.set(emp.name.trim().toLowerCase(), emp);
    } else {
      if (!emp.isServiceStaff) toMarkServiceStaff.add(emp.id);
      if (!emp.employeeCode) toSetCode.push({ id: emp.id, code });
    }

    byStaffId.set(staffId, { id: emp.id, name: emp.name });
  }

  if (toMarkServiceStaff.size > 0) {
    await prisma.employee.updateMany({
      where: { id: { in: [...toMarkServiceStaff] } },
      data: { isServiceStaff: true },
    });
  }
  for (const row of toSetCode) {
    await prisma.employee.update({
      where: { id: row.id },
      data: { employeeCode: row.code },
    });
  }

  return { byStaffId, created };
}

async function main() {
  const tenant = await prisma.tenant.findFirst({
    where: { code: tenantCode, deletedAt: null },
    select: { id: true, code: true },
  });
  if (!tenant) throw new Error(`Tenant ${tenantCode} not found`);

  let designation =
    (await prisma.designation.findFirst({
      where: {
        tenantId: tenant.id,
        deletedAt: null,
        name: { equals: 'TECHNICAL STAFF', mode: 'insensitive' },
      },
      select: { id: true },
    })) ??
    (await prisma.designation.findFirst({
      where: {
        tenantId: tenant.id,
        deletedAt: null,
        name: { equals: 'Staff', mode: 'insensitive' },
      },
      select: { id: true },
    }));

  if (!designation) {
    designation = await prisma.designation.create({
      data: { tenantId: tenant.id, name: 'TECHNICAL STAFF' },
      select: { id: true },
    });
  }

  console.log(
    `Parsing legacy SQL: ${legacySql}` +
      (legacyDb ? ` (db=${legacyDb})` : '') +
      ` offset=${legacyIdOffset}`,
  );
  const { byTx, userNames, source } = await loadLegacyStaffByTransaction();
  console.log(
    `Legacy source: ${source}; ${byTx.size} transactions with staff; ${userNames.size} users named`,
  );

  const offsetLegacyIds = [...byTx.keys()].map((id) => id + legacyIdOffset);
  const saleMaps: Array<{ legacyId: number; newId: string }> = [];
  for (let i = 0; i < offsetLegacyIds.length; i += 500) {
    const chunk = offsetLegacyIds.slice(i, i + 500);
    const rows = await prisma.migrationLegacyId.findMany({
      where: {
        tenantId: tenant.id,
        entityType: 'sale',
        legacyId: { in: chunk },
      },
      select: { legacyId: true, newId: true },
    });
    saleMaps.push(...rows);
  }
  const saleByOffsetLegacy = new Map(
    saleMaps.map((row) => [row.legacyId, row.newId]),
  );
  console.log(`Matched ${saleByOffsetLegacy.size} migrated sales for ${tenant.code}`);

  const uniqueStaffIds = [...new Set(byTx.values())];
  const { byStaffId, created: employeesCreated } = await resolveEmployees({
    tenantId: tenant.id,
    designationId: designation.id,
    staffIds: uniqueStaffIds,
    userNames,
  });
  console.log(
    `Resolved ${byStaffId.size} staff employees (${employeesCreated} created)`,
  );

  // Group sale ids by (employeeId, cleanerName) for batched updates
  const groups = new Map<string, { employeeId: string; name: string; saleIds: string[] }>();
  let skippedNoSale = 0;
  let skippedNoStaff = 0;

  for (const [rawTxId, staffUserId] of byTx) {
    const saleId = saleByOffsetLegacy.get(rawTxId + legacyIdOffset);
    if (!saleId) {
      skippedNoSale += 1;
      continue;
    }
    const employee = byStaffId.get(staffUserId);
    if (!employee) {
      skippedNoStaff += 1;
      continue;
    }
    const key = `${employee.id}::${employee.name}`;
    const g = groups.get(key) ?? {
      employeeId: employee.id,
      name: employee.name,
      saleIds: [],
    };
    g.saleIds.push(saleId);
    groups.set(key, g);
  }

  let updated = 0;
  let alreadySet = 0;
  let batchNo = 0;

  for (const group of groups.values()) {
    for (let i = 0; i < group.saleIds.length; i += BATCH) {
      batchNo += 1;
      const ids = group.saleIds.slice(i, i + BATCH);
      const result = await withRetry(
        () =>
          prisma.$executeRaw`
            UPDATE "Sale"
            SET
              "serviceStaffEmployeeId" = ${group.employeeId},
              "cleanerName" = ${group.name},
              "updatedAt" = NOW()
            WHERE "tenantId" = ${tenant.id}
              AND "deletedAt" IS NULL
              AND id IN (${Prisma.join(ids)})
              AND (
                "serviceStaffEmployeeId" IS DISTINCT FROM ${group.employeeId}
                OR "cleanerName" IS DISTINCT FROM ${group.name}
              )
          `,
        `raw update batch ${batchNo}`,
      );
      updated += Number(result);
      alreadySet += ids.length - Number(result);
      if (batchNo % 10 === 0) {
        console.log(`… updated ${updated} sales so far (batch ${batchNo})`);
      }
    }
  }

  const serviceStaff = await prisma.employee.count({
    where: { tenantId: tenant.id, deletedAt: null, isServiceStaff: true },
  });
  const salesWithStaff = await prisma.sale.count({
    where: {
      tenantId: tenant.id,
      deletedAt: null,
      serviceStaffEmployeeId: { not: null },
    },
  });

  console.log(
    JSON.stringify(
      {
        tenant: tenant.code,
        source,
        updated,
        alreadySet,
        skippedNoSale,
        skippedNoStaff,
        employeesCreated,
        serviceStaff,
        salesWithStaff,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
