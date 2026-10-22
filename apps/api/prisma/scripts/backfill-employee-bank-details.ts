/**
 * Backfill Employee bank / tax fields from Ultimate POS users.bank_details.
 *
 * Match: legacy users.id (string) → Employee.employeeCode
 *        (same key Payroll.employeeId already uses from expense_for).
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/backfill-employee-bank-details.ts
 *   TENANT_CODE=VA LEGACY_SQL="../../localhost (1).sql" LEGACY_DB=vonomglk_hq3temp \
 *     npx ts-node --transpile-only prisma/scripts/backfill-employee-bank-details.ts
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const tenantFilter = process.env.TENANT_CODE?.trim().toUpperCase();
const legacySql =
  process.env.LEGACY_SQL?.trim() ||
  path.resolve(process.cwd(), '../../localhost (1).sql');
/** When set, only parse that MySQL database from a multi-db dump. Empty = all. */
const legacyDb = process.env.LEGACY_DB?.trim() || '';

type BankDetails = {
  accountHolderName: string | null;
  bankName: string | null;
  bankBranch: string | null;
  bankCode: string | null;
  bankAccountNo: string | null;
  taxPayerId: string | null;
};

function emptyStr(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function parseBankJson(raw: string | null): BankDetails | null {
  if (!raw || raw === 'NULL') return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return null;
    const details: BankDetails = {
      accountHolderName: emptyStr(data.account_holder_name),
      bankName: emptyStr(data.bank_name),
      bankBranch: emptyStr(data.branch),
      bankCode: emptyStr(data.bank_code),
      bankAccountNo: emptyStr(data.account_number),
      taxPayerId: emptyStr(data.tax_payer_id),
    };
    if (
      !details.accountHolderName &&
      !details.bankName &&
      !details.bankBranch &&
      !details.bankCode &&
      !details.bankAccountNo &&
      !details.taxPayerId
    ) {
      return null;
    }
    return details;
  } catch {
    return null;
  }
}

function unescapeSql(value: string): string {
  return value
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
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

function extractValueTuples(insertLine: string): string[] {
  const valuesIdx = insertLine.indexOf('VALUES');
  if (valuesIdx < 0) return [];
  let body = insertLine.slice(valuesIdx + 6).trim();
  if (body.endsWith(';')) body = body.slice(0, -1);
  const tuples: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      if (ch === '\\' && i + 1 < body.length) {
        i += 1;
        continue;
      }
      if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      continue;
    }
    if (ch === '(') {
      if (depth === 0) start = i + 1;
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        tuples.push(body.slice(start, i));
        start = -1;
      }
    }
  }
  return tuples;
}

async function loadBankByUserId(): Promise<Map<string, BankDetails>> {
  const byUserId = new Map<string, BankDetails>();
  let currentDb: string | null = null;
  let mode: 'none' | 'create_users' | 'insert_users' = 'none';
  let createBuf: string[] = [];
  let userCols: string[] | null = null;
  let insertBuf = '';

  const inScopeDb = (): boolean => {
    if (!legacyDb) return true;
    return currentDb === legacyDb;
  };

  const flushInsert = () => {
    if (!insertBuf || !userCols) {
      insertBuf = '';
      return;
    }
    const idIdx = userCols.indexOf('id');
    const bankIdx = userCols.indexOf('bank_details');
    if (idIdx < 0 || bankIdx < 0) {
      insertBuf = '';
      return;
    }
    for (const tuple of extractValueTuples(insertBuf)) {
      const fields = parseTupleFields(tuple);
      const idRaw = fields[idIdx]?.trim();
      const bankRaw = fields[bankIdx];
      if (!idRaw || idRaw === 'NULL' || !bankRaw || bankRaw === 'NULL') continue;
      const details = parseBankJson(unescapeSql(bankRaw));
      if (details) byUserId.set(String(idRaw), details);
    }
    insertBuf = '';
  };

  const rl = createInterface({
    input: createReadStream(legacySql, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const useMatch = line.match(/^USE `([^`]+)`/);
    if (useMatch) {
      flushInsert();
      currentDb = useMatch[1] ?? null;
      mode = 'none';
      createBuf = [];
      continue;
    }

    if (!inScopeDb()) continue;

    if (line.startsWith('CREATE TABLE `users`')) {
      mode = 'create_users';
      createBuf = [];
      continue;
    }
    if (mode === 'create_users') {
      createBuf.push(line);
      if (line.startsWith(')')) {
        userCols = parseCreateColumns(createBuf);
        mode = 'none';
        createBuf = [];
      }
      continue;
    }

    if (line.startsWith('INSERT INTO `users`')) {
      flushInsert();
      mode = 'insert_users';
      insertBuf = line;
      if (line.trimEnd().endsWith(';')) {
        flushInsert();
        mode = 'none';
      }
      continue;
    }
    if (mode === 'insert_users') {
      insertBuf += line;
      if (line.trimEnd().endsWith(';')) {
        flushInsert();
        mode = 'none';
      }
    }
  }
  flushInsert();

  return byUserId;
}

async function backfillTenant(
  tenant: { id: string; code: string },
  bankByUserId: Map<string, BankDetails>,
) {
  const employees = await prisma.employee.findMany({
    where: {
      tenantId: tenant.id,
      deletedAt: null,
      employeeCode: { not: null },
    },
    select: {
      id: true,
      employeeCode: true,
      bankName: true,
      bankAccountNo: true,
    },
  });

  let updated = 0;
  let matched = 0;
  let skippedHasBank = 0;

  for (const emp of employees) {
    const code = emp.employeeCode?.trim();
    if (!code) continue;
    const details = bankByUserId.get(code);
    if (!details) continue;
    matched += 1;
    if (emp.bankName || emp.bankAccountNo) {
      skippedHasBank += 1;
      // Still overwrite if FORCE=1
      if (process.env.FORCE !== '1') continue;
    }
    await prisma.employee.update({
      where: { id: emp.id },
      data: {
        accountHolderName: details.accountHolderName,
        bankName: details.bankName,
        bankBranch: details.bankBranch,
        bankCode: details.bankCode,
        bankAccountNo: details.bankAccountNo,
        taxPayerId: details.taxPayerId,
      },
    });
    updated += 1;
  }

  // Also match Payroll.employeeId → create/update via employeeCode path already covered;
  // link orphan payroll employeeIds that have no Employee yet? Leave to backfill-employees.
  return {
    employees: employees.length,
    matched,
    updated,
    skippedHasBank,
  };
}

async function main() {
  console.log(`Parsing bank_details from ${legacySql}` + (legacyDb ? ` (db=${legacyDb})` : ' (all dbs)'));
  const bankByUserId = await loadBankByUserId();
  console.log(`Loaded bank details for ${bankByUserId.size} legacy users`);

  const tenants = await prisma.tenant.findMany({
    where: tenantFilter ? { code: tenantFilter } : undefined,
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });

  if (tenants.length === 0) {
    console.error(
      tenantFilter
        ? `No tenant found for TENANT_CODE=${tenantFilter}`
        : 'No tenants found',
    );
    process.exit(1);
  }

  for (const tenant of tenants) {
    const result = await backfillTenant(tenant, bankByUserId);
    console.log(
      `${tenant.code}: ${result.updated} updated / ${result.matched} matched / ${result.employees} employees` +
        (result.skippedHasBank
          ? ` (${result.skippedHasBank} already had bank; set FORCE=1 to overwrite)`
          : ''),
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
