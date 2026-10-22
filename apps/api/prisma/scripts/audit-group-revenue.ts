/**
 * Compare VAG Group Revenue sources for last 7 days:
 * TenantDailyFinance rollup vs live LedgerEntry vs Sale.total
 */
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

function dayStart(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function sum(rows: Array<Record<string, unknown>>, key: string): number {
  return rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);
}

async function main() {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 7);
  const fromDay = dayStart(from);
  const toDay = dayStart(now);

  const tenants = await prisma.tenant.findMany({
    where: {
      code: { in: ["VA", "VW", "VISP", "VSP", "VC", "VS", "VKW"] },
      deletedAt: null,
    },
    select: { id: true, code: true },
  });
  const ids = tenants.map((t) => t.id);
  const byId = Object.fromEntries(tenants.map((t) => [t.id, t.code]));

  console.log("Window", from.toISOString(), "→", now.toISOString());
  console.log("Rollup day bounds", fromDay.toISOString(), "→", toDay.toISOString());

  const rollup = await prisma.$queryRaw<
    Array<{ code: string; revenue: number; days: number }>
  >`
    SELECT t.code, COALESCE(SUM(f.revenue), 0)::float AS revenue, COUNT(*)::int AS days
    FROM "TenantDailyFinance" f
    JOIN "Tenant" t ON t.id = f."tenantId"
    WHERE f."tenantId" IN (${Prisma.join(ids)})
      AND f.date >= ${fromDay}
      AND f.date <= ${toDay}
    GROUP BY t.code
    ORDER BY t.code
  `;

  const liveExcl = await prisma.$queryRaw<
    Array<{ code: string; revenue: number; rows: number }>
  >`
    SELECT t.code, COALESCE(SUM(l.amount), 0)::float AS revenue, COUNT(*)::int AS rows
    FROM "LedgerEntry" l
    JOIN "Tenant" t ON t.id = l."tenantId"
    WHERE l."deletedAt" IS NULL
      AND l.type = 'revenue'
      AND l.date >= ${from}
      AND l.date <= ${now}
      AND l."tenantId" IN (${Prisma.join(ids)})
      AND l."isInternalTransfer" = false
      AND NOT (
        LOWER(COALESCE(l.category, '') || ' ' || COALESCE(l.description, '')) LIKE '%internal transfer%'
        OR LOWER(COALESCE(l.category, '') || ' ' || COALESCE(l.description, '')) LIKE '%stock transfer%'
        OR LOWER(COALESCE(l.category, '') || ' ' || COALESCE(l.description, '')) LIKE '%requisition fulfillment%'
        OR LOWER(COALESCE(l.category, '') || ' ' || COALESCE(l.description, '')) LIKE '%inter-entity transfer%'
      )
    GROUP BY t.code
    ORDER BY t.code
  `;

  const liveDeduped = await prisma.$queryRaw<
    Array<{ code: string; revenue: number; rows: number }>
  >`
    SELECT t.code, COALESCE(SUM(l.amount), 0)::float AS revenue, COUNT(*)::int AS rows
    FROM "LedgerEntry" l
    JOIN "Tenant" t ON t.id = l."tenantId"
    WHERE l."deletedAt" IS NULL
      AND l.type = 'revenue'
      AND l.date >= ${from}
      AND l.date <= ${now}
      AND l."tenantId" IN (${Prisma.join(ids)})
      AND l."isInternalTransfer" = false
      AND NOT (
        LOWER(COALESCE(l.category, '') || ' ' || COALESCE(l.description, '')) LIKE '%internal transfer%'
        OR LOWER(COALESCE(l.category, '') || ' ' || COALESCE(l.description, '')) LIKE '%stock transfer%'
        OR LOWER(COALESCE(l.category, '') || ' ' || COALESCE(l.description, '')) LIKE '%requisition fulfillment%'
        OR LOWER(COALESCE(l.category, '') || ' ' || COALESCE(l.description, '')) LIKE '%inter-entity transfer%'
      )
      AND NOT (
        l."linkedRecordType" = 'job'
        AND EXISTS (
          SELECT 1
          FROM "LedgerEntry" s
          WHERE s."tenantId" = l."tenantId"
            AND s."deletedAt" IS NULL
            AND s.type = 'revenue'
            AND s."linkedRecordType" = 'sale'
            AND s.amount = l.amount
            AND date_trunc('day', s.date AT TIME ZONE 'UTC')
              = date_trunc('day', l.date AT TIME ZONE 'UTC')
            AND lower(regexp_replace(COALESCE(s.description, ''), '^sale\\s+', '', 'i'))
              = lower(regexp_replace(COALESCE(l.description, ''), '^job\\s+', '', 'i'))
        )
      )
    GROUP BY t.code
    ORDER BY t.code
  `;

  const liveAll = await prisma.$queryRaw<
    Array<{ code: string; revenue: number; rows: number }>
  >`
    SELECT t.code, COALESCE(SUM(l.amount), 0)::float AS revenue, COUNT(*)::int AS rows
    FROM "LedgerEntry" l
    JOIN "Tenant" t ON t.id = l."tenantId"
    WHERE l."deletedAt" IS NULL
      AND l.type = 'revenue'
      AND l.date >= ${from}
      AND l.date <= ${now}
      AND l."tenantId" IN (${Prisma.join(ids)})
    GROUP BY t.code
    ORDER BY t.code
  `;

  const sales = await prisma.$queryRaw<
    Array<{ code: string; sales_total: number; cnt: number }>
  >`
    SELECT t.code, COALESCE(SUM(s.total), 0)::float AS sales_total, COUNT(*)::int AS cnt
    FROM "Sale" s
    JOIN "Tenant" t ON t.id = s."tenantId"
    WHERE s."deletedAt" IS NULL
      AND s.status::text <> 'draft'
      AND s.date >= ${from}
      AND s.date <= ${now}
      AND s."tenantId" IN (${Prisma.join(ids)})
    GROUP BY t.code
    ORDER BY t.code
  `;

  const rollupAny = await prisma.tenantDailyFinance.groupBy({
    by: ["tenantId"],
    where: { tenantId: { in: ids } },
    _count: { _all: true },
    _min: { date: true },
    _max: { date: true },
  });

  console.log("\n=== Per-tenant last 7d ===");
  console.log("ROLLUP (VAG path):", rollup);
  console.log("LIVE ledger excl internal:", liveExcl);
  console.log("LIVE ledger excl internal + sale/job dedupe:", liveDeduped);
  console.log("LIVE ledger all revenue:", liveAll);
  console.log("SALE.total:", sales);

  console.log("\n=== GROUP TOTALS ===");
  console.log("rollup:", sum(rollup, "revenue"));
  console.log("live excl internal:", sum(liveExcl, "revenue"));
  console.log("live excl internal + dedupe:", sum(liveDeduped, "revenue"));
  console.log("live all:", sum(liveAll, "revenue"));
  console.log("sales.total:", sum(sales, "sales_total"));
  console.log(
    "delta rollup - liveDeduped:",
    sum(rollup, "revenue") - sum(liveDeduped, "revenue"),
  );
  console.log(
    "delta liveExcl - liveDeduped (double-count removed):",
    sum(liveExcl, "revenue") - sum(liveDeduped, "revenue"),
  );
  console.log(
    "delta sales - rollup:",
    sum(sales, "sales_total") - sum(rollup, "revenue"),
  );

  console.log("\n=== Rollup coverage (any date) ===");
  for (const r of rollupAny) {
    console.log(
      byId[r.tenantId],
      "rows",
      r._count._all,
      "min",
      r._min.date?.toISOString().slice(0, 10),
      "max",
      r._max.date?.toISOString().slice(0, 10),
    );
  }

  const va = tenants.find((t) => t.code === "VA");
  if (va) {
    const days = await prisma.$queryRaw<
      Array<{
        d: string;
        ledger_rev: number;
        rollup_rev: number;
        delta: number;
      }>
    >`
      WITH days AS (
        SELECT generate_series(${fromDay}::date, ${toDay}::date, '1 day'::interval)::date AS d
      ),
      led AS (
        SELECT (date_trunc('day', date AT TIME ZONE 'UTC'))::date AS d,
               SUM(CASE WHEN type = 'revenue' THEN amount ELSE 0 END)::float AS rev
        FROM "LedgerEntry"
        WHERE "tenantId" = ${va.id}
          AND "deletedAt" IS NULL
          AND date >= ${fromDay}
          AND date < (${toDay}::date + 1)
        GROUP BY 1
      ),
      rol AS (
        SELECT date::date AS d, revenue::float AS rev
        FROM "TenantDailyFinance"
        WHERE "tenantId" = ${va.id}
          AND date >= ${fromDay}::date
          AND date <= ${toDay}::date
      )
      SELECT days.d::text AS d,
             COALESCE(led.rev, 0) AS ledger_rev,
             COALESCE(rol.rev, 0) AS rollup_rev,
             COALESCE(led.rev, 0) - COALESCE(rol.rev, 0) AS delta
      FROM days
      LEFT JOIN led ON led.d = days.d
      LEFT JOIN rol ON rol.d = days.d
      ORDER BY days.d
    `;
    console.log("\n=== VA day-by-day ledger vs rollup ===");
    console.table(days);
  }

  // Jobs with invoice amounts in window vs ledger
  const jobInv = await prisma.$queryRaw<
    Array<{ code: string; invoice_sum: number; cnt: number }>
  >`
    SELECT t.code,
           COALESCE(SUM(j."invoiceAmount"), 0)::float AS invoice_sum,
           COUNT(*)::int AS cnt
    FROM "Job" j
    JOIN "Tenant" t ON t.id = j."tenantId"
    WHERE j."deletedAt" IS NULL
      AND j."createdAt" >= ${from}
      AND j."createdAt" <= ${now}
      AND j."tenantId" IN (${Prisma.join(ids)})
    GROUP BY t.code
    ORDER BY t.code
  `;
  console.log("\n=== Jobs created in window (invoiceAmount sum) ===");
  console.log(jobInv);
  console.log("job invoice sum:", sum(jobInv, "invoice_sum"));
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    void prisma.$disconnect();
    process.exit(1);
  });
