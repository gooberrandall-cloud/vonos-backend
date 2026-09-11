/**
 * Backfill Sale / inbound StockMovement.paymentMethod from legacy SQL.
 *
 * Complements backfill-payment-methods-from-payments.ts (which uses Payment.saleId /
 * paymentFor=purchase). Retail tenants often lack those links — this walks
 * transaction_payments → transaction_id → MigrationLegacyId (sale|stock_movement).
 *
 * Also fills prefer_payment_method from transactions when no payment method exists.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/backfill-payment-methods-from-legacy.ts
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
  { db: 'vonomglk_spmarket', tenantCode: 'VSP', offset: 0 },
];

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

type TxPay = { txId: number; method: string; amount: number };
type Prefer = { txId: number; method: string; type: string };

type DbScan = {
  payments: TxPay[];
  prefers: Prefer[];
};

async function scanDb(dbName: string): Promise<DbScan> {
  const payments: TxPay[] = [];
  const prefers: Prefer[] = [];

  const rl = createInterface({
    input: createReadStream(legacySql, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let inDb = false;
  let mode:
    | 'none'
    | 'create_tx'
    | 'create_pay'
    | 'transactions'
    | 'payments' = 'none';
  let createBuf: string[] = [];
  let txCols: string[] | null = null;
  let payCols: string[] | null = null;

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
    if (line.startsWith('CREATE TABLE `transaction_payments`')) {
      mode = 'create_pay';
      createBuf = [];
      continue;
    }
    if (mode === 'create_tx' || mode === 'create_pay') {
      createBuf.push(line);
      if (line.startsWith(')')) {
        const cols = parseCreateColumns(createBuf);
        if (mode === 'create_tx') txCols = cols;
        else payCols = cols;
        mode = 'none';
        createBuf = [];
      }
      continue;
    }

    if (line.startsWith('INSERT INTO `transactions`')) {
      mode = 'transactions';
      continue;
    }
    if (line.startsWith('INSERT INTO `transaction_payments`')) {
      mode = 'payments';
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

    if (mode === 'payments') {
      const txIdx = payCols?.indexOf('transaction_id') ?? 1;
      const methodIdx = payCols?.indexOf('method') ?? -1;
      const amountIdx = payCols?.indexOf('amount') ?? -1;
      if (methodIdx < 0 || fields.length <= Math.max(txIdx, methodIdx)) continue;
      const txId = Number(fields[txIdx]);
      const method = (fields[methodIdx] ?? '').replace(/^'|'$/g, '').trim();
      const amount = amountIdx >= 0 ? Number(fields[amountIdx]) : 0;
      if (!Number.isFinite(txId) || !method || method === 'NULL') continue;
      payments.push({
        txId,
        method,
        amount: Number.isFinite(amount) ? amount : 0,
      });
      continue;
    }

    if (mode === 'transactions') {
      const typeIdx = txCols?.indexOf('type') ?? 7;
      const preferIdx = txCols?.indexOf('prefer_payment_method') ?? -1;
      if (preferIdx < 0 || fields.length <= Math.max(typeIdx, preferIdx)) continue;
      const txType = (fields[typeIdx] ?? '').replace(/^'|'$/g, '');
      if (txType !== 'sell' && txType !== 'purchase' && txType !== 'opening_stock') {
        continue;
      }
      const txId = Number(fields[0]);
      const method = (fields[preferIdx] ?? '').replace(/^'|'$/g, '').trim();
      if (!Number.isFinite(txId) || !method || method === 'NULL') continue;
      prefers.push({ txId, method, type: txType });
    }
  }

  return { payments, prefers };
}

function bestMethodByTx(rows: TxPay[]): Map<number, string> {
  const best = new Map<number, { method: string; amount: number }>();
  for (const row of rows) {
    const cur = best.get(row.txId);
    if (!cur || row.amount > cur.amount) {
      best.set(row.txId, { method: row.method, amount: row.amount });
    }
  }
  return new Map([...best].map(([id, v]) => [id, v.method]));
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN' : 'WRITE');
  console.log(`SQL: ${legacySql}`);

  const tenants = await prisma.tenant.findMany({
    where: { code: { in: [...new Set(SOURCES.map((s) => s.tenantCode))] } },
    select: { id: true, code: true },
  });
  const tenantByCode = new Map(tenants.map((t) => [t.code, t.id]));

  let saleUpdated = 0;
  let purchUpdated = 0;

  for (const source of SOURCES) {
    const tenantId = tenantByCode.get(source.tenantCode);
    if (!tenantId) {
      console.warn(`Skip ${source.db}: tenant ${source.tenantCode} not found`);
      continue;
    }

    console.log(
      `\nScanning ${source.db} → ${source.tenantCode} (offset +${source.offset})…`,
    );
    const scan = await scanDb(source.db);
    const methodByTx = bestMethodByTx(scan.payments);
    console.log(
      `  payment rows: ${scan.payments.length}, txs with method: ${methodByTx.size}, prefer: ${scan.prefers.length}`,
    );

    const maps = await prisma.migrationLegacyId.findMany({
      where: {
        tenantId,
        entityType: { in: ['sale', 'stock_movement'] },
      },
      select: { entityType: true, legacyId: true, newId: true },
    });

    const saleByLegacy = new Map<number, string>();
    const movByLegacy = new Map<number, string>();
    for (const m of maps) {
      // Strip this source's offset; skip IDs that belong to another offset bucket.
      if (source.offset > 0) {
        if (m.legacyId < source.offset || m.legacyId >= source.offset + 10_000_000) {
          continue;
        }
      } else if (m.legacyId >= 10_000_000) {
        continue;
      }
      const raw = m.legacyId - source.offset;
      if (m.entityType === 'sale') saleByLegacy.set(raw, m.newId);
      else movByLegacy.set(raw, m.newId);
    }
    console.log(
      `  legacy maps in bucket: sales ${saleByLegacy.size}, movements ${movByLegacy.size}`,
    );

    const saleMethod = new Map<string, string>();
    const movMethod = new Map<string, string>();

    for (const [txId, method] of methodByTx) {
      const saleId = saleByLegacy.get(txId);
      if (saleId) saleMethod.set(saleId, method);
      const movId = movByLegacy.get(txId);
      if (movId) movMethod.set(movId, method);
    }
    // prefer_payment_method only fills gaps (payments win)
    for (const pref of scan.prefers) {
      if (pref.type === 'sell') {
        const saleId = saleByLegacy.get(pref.txId);
        if (saleId && !saleMethod.has(saleId)) saleMethod.set(saleId, pref.method);
      } else {
        const movId = movByLegacy.get(pref.txId);
        if (movId && !movMethod.has(movId)) movMethod.set(movId, pref.method);
      }
    }

    const salesNeeding = await prisma.sale.findMany({
      where: {
        tenantId,
        deletedAt: null,
        id: { in: [...saleMethod.keys()] },
        OR: [{ paymentMethod: null }, { paymentMethod: '' }],
      },
      select: { id: true },
    });
    const purchNeeding = await prisma.stockMovement.findMany({
      where: {
        tenantId,
        deletedAt: null,
        type: 'inbound',
        id: { in: [...movMethod.keys()] },
        OR: [{ paymentMethod: null }, { paymentMethod: '' }],
      },
      select: { id: true },
    });

    const salePatches = salesNeeding
      .map((s) => ({ id: s.id, method: saleMethod.get(s.id)! }))
      .filter((p) => p.method);
    const purchPatches = purchNeeding
      .map((m) => ({ id: m.id, method: movMethod.get(m.id)! }))
      .filter((p) => p.method);

    console.log(
      `  patches: sales ${salePatches.length}, purchases ${purchPatches.length}`,
    );

    if (DRY_RUN) continue;

    const BATCH = 150;
    for (let i = 0; i < salePatches.length; i += BATCH) {
      const chunk = salePatches.slice(i, i + BATCH);
      await prisma.$transaction(
        chunk.map((row) =>
          prisma.sale.update({
            where: { id: row.id },
            data: { paymentMethod: row.method },
          }),
        ),
      );
    }
    for (let i = 0; i < purchPatches.length; i += BATCH) {
      const chunk = purchPatches.slice(i, i + BATCH);
      await prisma.$transaction(
        chunk.map((row) =>
          prisma.stockMovement.update({
            where: { id: row.id },
            data: { paymentMethod: row.method },
          }),
        ),
      );
    }
    saleUpdated += salePatches.length;
    purchUpdated += purchPatches.length;
  }

  const after = await prisma.$queryRaw<
    Array<{
      code: string;
      sales_with: number;
      sales_total: number;
      purch_with: number;
      purch_total: number;
    }>
  >`
    SELECT t.code,
      (SELECT COUNT(*)::int FROM "Sale" s WHERE s."tenantId" = t.id AND s."deletedAt" IS NULL
        AND s."paymentMethod" IS NOT NULL AND s."paymentMethod" <> '') AS sales_with,
      (SELECT COUNT(*)::int FROM "Sale" s WHERE s."tenantId" = t.id AND s."deletedAt" IS NULL) AS sales_total,
      (SELECT COUNT(*)::int FROM "StockMovement" m WHERE m."tenantId" = t.id AND m."deletedAt" IS NULL
        AND m.type = 'inbound' AND m."paymentMethod" IS NOT NULL AND m."paymentMethod" <> '') AS purch_with,
      (SELECT COUNT(*)::int FROM "StockMovement" m WHERE m."tenantId" = t.id AND m."deletedAt" IS NULL
        AND m.type = 'inbound') AS purch_total
    FROM "Tenant" t
    WHERE t.code IN ('VA', 'VC', 'VISP', 'VSP', 'VP')
    ORDER BY t.code
  `;

  console.log('\nDone', { saleUpdated, purchUpdated, DRY_RUN, after });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
