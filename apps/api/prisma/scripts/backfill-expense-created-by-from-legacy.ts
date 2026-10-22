/**
 * Backfill Expense.createdByName from legacy Ultimate POS transactions.created_by.
 *
 * Migrated expenses stored createdById=null and (before the ETL fix) no name.
 * Names come from users via transactions where type='expense'.
 *
 * Sources (localhost.sql multi-DB dump):
 *   VA: vonomglk_hq3temp (+20M), vonomglk_hq2 (+30M)
 *   VC: vonomglk_cafe (no offset)
 *   VISP: vonomglk_vsp (no offset)
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/backfill-expense-created-by-from-legacy.ts
 *   DRY_RUN=1 ...
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const legacySql =
  process.env.LEGACY_SQL?.trim() ||
  path.resolve(process.cwd(), '../../localhost.sql');

type Source = {
  db: string;
  tenantCode: string;
  offset: number;
};

const SOURCES: Source[] = [
  { db: 'vonomglk_hq3temp', tenantCode: 'VA', offset: 20_000_000 },
  { db: 'vonomglk_hq2', tenantCode: 'VA', offset: 30_000_000 },
  { db: 'vonomglk_cafe', tenantCode: 'VC', offset: 0 },
  { db: 'vonomglk_vsp', tenantCode: 'VISP', offset: 0 },
];

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

function parseCreateColumns(lines: string[]): string[] {
  const cols: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*`([^`]+)`/);
    if (m) cols.push(m[1]!);
  }
  return cols;
}

type DbScan = {
  /** keyed legacy id WITH offset applied (matches MigrationLegacyId.legacyId) */
  createdByUserId: Map<number, number>;
  userNames: Map<number, string>;
};

async function scanDb(dbName: string, offset: number): Promise<DbScan> {
  const createdByUserId = new Map<number, number>();
  const userNames = new Map<number, string>();

  const rl = createInterface({
    input: createReadStream(legacySql, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let inDb = false;
  let mode: 'none' | 'create_tx' | 'create_users' | 'transactions' | 'users' =
    'none';
  let createBuf: string[] = [];
  let txCols: string[] | null = null;
  let userCols: string[] | null = null;

  for await (const line of rl) {
    if (line.startsWith('USE `')) {
      const m = line.match(/^USE `([^`]+)`/);
      inDb = m?.[1] === dbName;
      mode = 'none';
      continue;
    }
    if (!inDb) continue;

    if (line.startsWith('CREATE TABLE `transactions`')) {
      mode = 'create_tx';
      createBuf = [];
      continue;
    }
    if (line.startsWith('CREATE TABLE `users`')) {
      mode = 'create_users';
      createBuf = [];
      continue;
    }
    if (mode === 'create_tx' || mode === 'create_users') {
      createBuf.push(line);
      if (line.startsWith(')')) {
        const cols = parseCreateColumns(createBuf);
        if (mode === 'create_tx') txCols = cols;
        else userCols = cols;
        mode = 'none';
        createBuf = [];
      }
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
      const createdByIdx = txCols?.indexOf('created_by') ?? -1;
      if (createdByIdx < 0 || fields.length <= Math.max(typeIdx, createdByIdx)) {
        continue;
      }
      const txType = fields[typeIdx]?.replace(/^'|'$/g, '');
      if (txType !== 'expense') continue;
      const txId = Number(fields[0]);
      const createdByRaw = fields[createdByIdx] ?? 'NULL';
      if (!Number.isFinite(txId)) continue;
      if (
        !createdByRaw ||
        createdByRaw === 'NULL' ||
        !/^[1-9]\d*$/.test(createdByRaw)
      ) {
        continue;
      }
      createdByUserId.set(txId + offset, Number(createdByRaw));
      continue;
    }

    if (mode === 'users') {
      const idIdx = userCols?.indexOf('id') ?? 0;
      const surnameIdx = userCols?.indexOf('surname') ?? 2;
      const firstIdx = userCols?.indexOf('first_name') ?? 3;
      const lastIdx = userCols?.indexOf('last_name') ?? 4;
      const tuples = line.match(/\((?:[^()]|'[^']*')*\)/g) ?? [trimmed];
      for (const raw of tuples) {
        const uFields = parseTupleFields(raw.slice(1, -1));
        if (uFields.length <= Math.max(idIdx, surnameIdx, firstIdx, lastIdx)) {
          continue;
        }
        const uid = Number(uFields[idIdx]);
        if (!Number.isFinite(uid)) continue;
        const surname = unescapeSql(uFields[surnameIdx] ?? '');
        const first = unescapeSql(uFields[firstIdx] ?? '');
        const last = unescapeSql(uFields[lastIdx] ?? '');
        const name =
          [first, last].filter(Boolean).join(' ').trim() || surname.trim();
        if (name) userNames.set(uid, name);
      }
    }
  }

  return { createdByUserId, userNames };
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN' : 'WRITE');
  console.log(`SQL: ${legacySql}`);

  const tenants = await prisma.tenant.findMany({
    where: { code: { in: [...new Set(SOURCES.map((s) => s.tenantCode))] } },
    select: { id: true, code: true },
  });
  const tenantByCode = new Map(tenants.map((t) => [t.code, t.id]));

  let updated = 0;
  let already = 0;
  let missingMap = 0;
  let missingName = 0;

  for (const source of SOURCES) {
    const tenantId = tenantByCode.get(source.tenantCode);
    if (!tenantId) {
      console.warn(`Skip ${source.db}: tenant ${source.tenantCode} not found`);
      continue;
    }

    console.log(
      `\nScanning ${source.db} → ${source.tenantCode} (offset +${source.offset})…`,
    );
    const scan = await scanDb(source.db, source.offset);
    console.log(
      `  expense txs with created_by: ${scan.createdByUserId.size}, users: ${scan.userNames.size}`,
    );

    const maps = await prisma.migrationLegacyId.findMany({
      where: {
        tenantId,
        entityType: 'expense',
        legacyId: { in: [...scan.createdByUserId.keys()] },
      },
      select: { legacyId: true, newId: true },
    });
    const mapByLegacy = new Map(maps.map((m) => [m.legacyId, m.newId]));

    const expenses = await prisma.expense.findMany({
      where: {
        tenantId,
        deletedAt: null,
        id: { in: maps.map((m) => m.newId) },
      },
      select: { id: true, createdByName: true },
    });
    const expenseById = new Map(expenses.map((e) => [e.id, e]));

    const patches: Array<{ id: string; createdByName: string }> = [];
    for (const [legacyId, userId] of scan.createdByUserId) {
      const newId = mapByLegacy.get(legacyId);
      if (!newId) {
        missingMap += 1;
        continue;
      }
      const expense = expenseById.get(newId);
      if (!expense) continue;
      if (expense.createdByName?.trim()) {
        already += 1;
        continue;
      }
      const name = scan.userNames.get(userId)?.trim();
      if (!name) {
        missingName += 1;
        continue;
      }
      patches.push({ id: newId, createdByName: name });
    }

    console.log(`  patches: ${patches.length}`);
    if (!DRY_RUN) {
      const BATCH = 100;
      for (let i = 0; i < patches.length; i += BATCH) {
        const chunk = patches.slice(i, i + BATCH);
        await prisma.$transaction(
          chunk.map((p) =>
            prisma.expense.update({
              where: { id: p.id },
              data: { createdByName: p.createdByName },
            }),
          ),
        );
      }
    }
    updated += patches.length;
  }

  console.log('\nDone', { updated, already, missingMap, missingName, DRY_RUN });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
