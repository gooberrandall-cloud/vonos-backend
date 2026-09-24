/**
 * EXPLAIN (ANALYZE, BUFFERS) suite for VA list pages.
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/explain-va-lists.ts
 *
 * Prefers the direct (non-pooler) Neon host, then falls back to the pooler URL.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const VA = 'tenant_va_001';

function loadDatabaseUrls(): string[] {
  const envPath = join(__dirname, '../../.env');
  const env = readFileSync(envPath, 'utf8');
  const raw = env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('DATABASE_URL not found in apps/api/.env');

  const withParams = (url: string) => {
    const sep = url.includes('?') ? '&' : '?';
    const hasSsl = /sslmode=/.test(url);
    return `${url}${sep}connection_limit=1&pool_timeout=60${hasSsl ? '' : '&sslmode=require'}`;
  };

  const direct = raw.replace('-pooler.', '.');
  return [...new Set([withParams(direct), withParams(raw)])];
}

async function connect(): Promise<PrismaClient> {
  for (const url of loadDatabaseUrls()) {
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      return prisma;
    } catch {
      await prisma.$disconnect().catch(() => undefined);
    }
  }
  throw new Error('Could not connect via direct or pooler DATABASE_URL');
}

type ExplainResult = {
  label: string;
  execMs: number;
  planMs: number;
  hasSeqScan: boolean;
  indexes: string[];
  top: string;
};

function summarize(planText: string): Omit<ExplainResult, 'label'> {
  const execMs = Number(planText.match(/Execution Time:\s*([\d.]+)/)?.[1] ?? 0);
  const planMs = Number(planText.match(/Planning Time:\s*([\d.]+)/)?.[1] ?? 0);
  const hasSeqScan = /Seq Scan on/.test(planText);
  const indexes = [
    ...new Set(
      [...planText.matchAll(/using "?([^"\s]+)"?/g)].map((m) => m[1] ?? ''),
    ),
  ].filter(Boolean);
  return {
    execMs,
    planMs,
    hasSeqScan,
    indexes: indexes.slice(0, 8),
    top: planText.split('\n').slice(0, 14).join('\n'),
  };
}

async function explain(
  prisma: PrismaClient,
  label: string,
  sql: string,
): Promise<ExplainResult> {
  const rows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
  );
  const text = rows.map((r) => r['QUERY PLAN']).join('\n');
  return { label, ...summarize(text) };
}

async function main() {
  const prisma = await connect();

  try {
    const queries: Array<[string, string]> = [
      [
        'customers list',
        `SELECT c.id, c.name FROM "Customer" c
         WHERE c."tenantId"='${VA}' AND c."deletedAt" IS NULL
         ORDER BY c.name ASC, c.id ASC LIMIT 26`,
      ],
      [
        'customers search',
        `SELECT c.id FROM "Customer" c
         WHERE c."tenantId"='${VA}' AND c."deletedAt" IS NULL
           AND (c.name ILIKE '%john%' OR c.email ILIKE '%john%' OR c.phone ILIKE '%john%')
         ORDER BY c.name ASC, c.id ASC LIMIT 26`,
      ],
      [
        'invoices list',
        `SELECT i.id, i.reference FROM "Invoice" i
         WHERE i."tenantId"='${VA}' AND i."deletedAt" IS NULL
         ORDER BY i."documentDate" DESC, i.id DESC LIMIT 26`,
      ],
      [
        'invoices search',
        `SELECT i.id FROM "Invoice" i
         WHERE i."tenantId"='${VA}' AND i."deletedAt" IS NULL
           AND (i.reference ILIKE '%inv%' OR i."contactName" ILIKE '%inv%')
         ORDER BY i."documentDate" DESC, i.id DESC LIMIT 26`,
      ],
      [
        'jobs list',
        `SELECT j.id, j.reference FROM "Job" j
         WHERE j."tenantId"='${VA}' AND j."deletedAt" IS NULL
         ORDER BY j."createdAt" DESC, j.id DESC LIMIT 26`,
      ],
      [
        'jobs search',
        `SELECT j.id FROM "Job" j
         WHERE j."tenantId"='${VA}' AND j."deletedAt" IS NULL
           AND (j.reference ILIKE '%toyota%' OR j."customerName" ILIKE '%toyota%')
         ORDER BY j."createdAt" DESC, j.id DESC LIMIT 26`,
      ],
      [
        'items list',
        `SELECT i.id, i.name FROM "Item" i
         WHERE i."tenantId"='${VA}' AND i."deletedAt" IS NULL
         ORDER BY i."updatedAt" DESC, i.id DESC LIMIT 26`,
      ],
      [
        'items search',
        `SELECT i.id FROM "Item" i
         WHERE i."tenantId"='${VA}' AND i."deletedAt" IS NULL
           AND (i.name ILIKE '%brake%' OR i.sku ILIKE '%brake%' OR i."carModel" ILIKE '%brake%')
         ORDER BY i."updatedAt" DESC, i.id DESC LIMIT 26`,
      ],
      [
        'sales list',
        `SELECT s.id FROM "Sale" s
         WHERE s."tenantId"='${VA}' AND s."deletedAt" IS NULL
         ORDER BY s.date DESC, s.id DESC LIMIT 26`,
      ],
      [
        'movements list',
        `SELECT m.id FROM "StockMovement" m
         WHERE m."tenantId"='${VA}' AND m."deletedAt" IS NULL
         ORDER BY m.date DESC, m.id DESC LIMIT 26`,
      ],
      [
        'ledger list',
        `SELECT l.id FROM "LedgerEntry" l
         WHERE l."tenantId"='${VA}' AND l."deletedAt" IS NULL
         ORDER BY l.date DESC, l.id DESC LIMIT 26`,
      ],
      [
        'expenses list',
        `SELECT e.id FROM "Expense" e
         WHERE e."tenantId"='${VA}' AND e."deletedAt" IS NULL
         ORDER BY e."expenseDate" DESC, e.id DESC LIMIT 26`,
      ],
      [
        'payments list',
        `SELECT p.id FROM "Payment" p
         WHERE p."tenantId"='${VA}' AND p."deletedAt" IS NULL
         ORDER BY p."paidOn" DESC, p.id DESC LIMIT 26`,
      ],
      [
        'suppliers list',
        `SELECT s.id FROM "Supplier" s
         WHERE s."tenantId"='${VA}' AND s."deletedAt" IS NULL
         ORDER BY s.name ASC, s.id ASC LIMIT 26`,
      ],
    ];

    const results: ExplainResult[] = [];
    for (const [label, sql] of queries) {
      results.push(await explain(prisma, label, sql));
    }

    const summary = results
      .map((r) => ({
        query: r.label,
        ms: r.execMs,
        seq: r.hasSeqScan,
        indexes: r.indexes,
        verdict: r.hasSeqScan
          ? r.label.includes('search')
            ? 'SEQ_OR_TRGM'
            : 'SEQ'
          : 'OK',
      }))
      .sort((a, b) => b.ms - a.ms);

    console.log(
      JSON.stringify(
        {
          tenant: VA,
          summary,
          details: results
            .filter((r) => r.hasSeqScan || r.execMs >= 10)
            .map((r) => ({
              label: r.label,
              ms: r.execMs,
              indexes: r.indexes,
              plan: r.top,
            })),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
