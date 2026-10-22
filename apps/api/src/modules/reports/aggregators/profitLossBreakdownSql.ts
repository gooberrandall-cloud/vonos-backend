import type { ProfitLossBreakdownTab, ReportsTable } from '@vonos/types';
import type { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { toNumber } from '../../../common/utils/serializers';
import { resolveDateWindow } from './date-utils';

type AggRow = {
  label: string;
  revenue: Prisma.Decimal | number | null;
  cost: Prisma.Decimal | number | null;
  units?: Prisma.Decimal | number | null;
  reference?: string;
};

function gross(revenue: number, cost: number): number {
  return Math.round((revenue - cost) * 100) / 100;
}

function money(value: Prisma.Decimal | number | null | undefined): number {
  return Math.round(toNumber(value ?? 0) * 100) / 100;
}

function sortByGross(
  rows: Array<{ grossProfit: number; [key: string]: string | number }>,
) {
  return rows.sort((a, b) => b.grossProfit - a.grossProfit);
}

/**
 * Aggregate P&L breakdown dimensions in SQL — avoids loading sale+line graphs into Node.
 */
export async function queryProfitLossBreakdownTab(
  db: TenantScopedPrisma,
  tenantId: string,
  tab: ProfitLossBreakdownTab,
  from?: string,
  to?: string,
): Promise<ReportsTable> {
  const window = resolveDateWindow(from, to);
  const fromDate = window.from;
  const toDate = window.to;

  switch (tab) {
    case 'product': {
      const rows = await db.$queryRaw<AggRow[]>`
        SELECT
          COALESCE(NULLIF(sl.name, ''), NULLIF(sl.sku, ''), 'Item') AS label,
          SUM(sl."lineTotal") AS revenue,
          SUM(sl.quantity * COALESCE(i."costPrice", 0)) AS cost,
          SUM(sl.quantity) AS units
        FROM "SaleLine" sl
        INNER JOIN "Sale" s ON s.id = sl."saleId"
        LEFT JOIN "Item" i ON i.id = sl."itemId" AND i."deletedAt" IS NULL
        WHERE s."tenantId" = ${tenantId}
          AND s."deletedAt" IS NULL
          AND s.status::text <> 'draft'
          AND s.date >= ${fromDate}
          AND s.date <= ${toDate}
        GROUP BY 1
        ORDER BY (SUM(sl."lineTotal") - SUM(sl.quantity * COALESCE(i."costPrice", 0))) DESC
        LIMIT 500
      `;
      return {
        columns: [
          { key: 'product', header: 'Product' },
          { key: 'unitsSold', header: 'Units Sold' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: rows.map((row) => {
          const revenue = money(row.revenue);
          const cost = money(row.cost);
          return {
            product: row.label,
            unitsSold: toNumber(row.units ?? 0),
            grossProfit: gross(revenue, cost),
            revenue,
          };
        }),
      };
    }
    case 'category': {
      const rows = await db.$queryRaw<AggRow[]>`
        SELECT
          COALESCE(NULLIF(i.category, ''), 'Uncategorized') AS label,
          SUM(sl."lineTotal") AS revenue,
          SUM(sl.quantity * COALESCE(i."costPrice", 0)) AS cost
        FROM "SaleLine" sl
        INNER JOIN "Sale" s ON s.id = sl."saleId"
        LEFT JOIN "Item" i ON i.id = sl."itemId" AND i."deletedAt" IS NULL
        WHERE s."tenantId" = ${tenantId}
          AND s."deletedAt" IS NULL
          AND s.status::text <> 'draft'
          AND s.date >= ${fromDate}
          AND s.date <= ${toDate}
        GROUP BY 1
        ORDER BY (SUM(sl."lineTotal") - SUM(sl.quantity * COALESCE(i."costPrice", 0))) DESC
        LIMIT 200
      `;
      return {
        columns: [
          { key: 'category', header: 'Category' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGross(
          rows.map((row) => {
            const revenue = money(row.revenue);
            const cost = money(row.cost);
            return {
              category: row.label,
              grossProfit: gross(revenue, cost),
              revenue,
            };
          }),
        ),
      };
    }
    case 'brand': {
      const rows = await db.$queryRaw<AggRow[]>`
        SELECT
          COALESCE(NULLIF(b.name, ''), 'Unbranded') AS label,
          SUM(sl."lineTotal") AS revenue,
          SUM(sl.quantity * COALESCE(i."costPrice", 0)) AS cost
        FROM "SaleLine" sl
        INNER JOIN "Sale" s ON s.id = sl."saleId"
        LEFT JOIN "Item" i ON i.id = sl."itemId" AND i."deletedAt" IS NULL
        LEFT JOIN "Brand" b ON b.id = i."brandId" AND b."deletedAt" IS NULL
        WHERE s."tenantId" = ${tenantId}
          AND s."deletedAt" IS NULL
          AND s.status::text <> 'draft'
          AND s.date >= ${fromDate}
          AND s.date <= ${toDate}
        GROUP BY 1
        ORDER BY (SUM(sl."lineTotal") - SUM(sl.quantity * COALESCE(i."costPrice", 0))) DESC
        LIMIT 200
      `;
      return {
        columns: [
          { key: 'brand', header: 'Brand' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGross(
          rows.map((row) => {
            const revenue = money(row.revenue);
            const cost = money(row.cost);
            return {
              brand: row.label,
              grossProfit: gross(revenue, cost),
              revenue,
            };
          }),
        ),
      };
    }
    case 'customer': {
      const rows = await db.$queryRaw<AggRow[]>`
        SELECT
          COALESCE(NULLIF(c.name, ''), 'Walk-in') AS label,
          SUM(s.total) AS revenue,
          COALESCE(SUM(lc.cost), 0) AS cost
        FROM "Sale" s
        LEFT JOIN "Customer" c ON c.id = s."customerId"
        LEFT JOIN LATERAL (
          SELECT SUM(sl.quantity * COALESCE(i."costPrice", 0)) AS cost
          FROM "SaleLine" sl
          LEFT JOIN "Item" i ON i.id = sl."itemId" AND i."deletedAt" IS NULL
          WHERE sl."saleId" = s.id
        ) lc ON TRUE
        WHERE s."tenantId" = ${tenantId}
          AND s."deletedAt" IS NULL
          AND s.status::text <> 'draft'
          AND s.date >= ${fromDate}
          AND s.date <= ${toDate}
        GROUP BY 1
        ORDER BY (SUM(s.total) - COALESCE(SUM(lc.cost), 0)) DESC
        LIMIT 200
      `;
      return {
        columns: [
          { key: 'customer', header: 'Customer' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGross(
          rows.map((row) => {
            const revenue = money(row.revenue);
            const cost = money(row.cost);
            return {
              customer: row.label,
              grossProfit: gross(revenue, cost),
              revenue,
            };
          }),
        ),
      };
    }
    case 'location': {
      const rows = await db.$queryRaw<AggRow[]>`
        SELECT
          COALESCE(NULLIF(s."locationCode", ''), 'Default') AS label,
          SUM(s.total) AS revenue,
          COALESCE(SUM(lc.cost), 0) AS cost
        FROM "Sale" s
        LEFT JOIN LATERAL (
          SELECT SUM(sl.quantity * COALESCE(i."costPrice", 0)) AS cost
          FROM "SaleLine" sl
          LEFT JOIN "Item" i ON i.id = sl."itemId" AND i."deletedAt" IS NULL
          WHERE sl."saleId" = s.id
        ) lc ON TRUE
        WHERE s."tenantId" = ${tenantId}
          AND s."deletedAt" IS NULL
          AND s.status::text <> 'draft'
          AND s.date >= ${fromDate}
          AND s.date <= ${toDate}
        GROUP BY 1
        ORDER BY (SUM(s.total) - COALESCE(SUM(lc.cost), 0)) DESC
        LIMIT 100
      `;
      return {
        columns: [
          { key: 'location', header: 'Location' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGross(
          rows.map((row) => {
            const revenue = money(row.revenue);
            const cost = money(row.cost);
            return {
              location: row.label,
              grossProfit: gross(revenue, cost),
              revenue,
            };
          }),
        ),
      };
    }
    case 'service-staff': {
      const rows = await db.$queryRaw<AggRow[]>`
        SELECT
          COALESCE(
            NULLIF(TRIM(s."cleanerName"), ''),
            NULLIF(TRIM(e.name), ''),
            NULLIF(TRIM(u.name), ''),
            'Unassigned'
          ) AS label,
          SUM(s.total) AS revenue,
          COALESCE(SUM(lc.cost), 0) AS cost
        FROM "Sale" s
        LEFT JOIN "Employee" e
          ON e.id = s."serviceStaffEmployeeId"
          AND e."deletedAt" IS NULL
        LEFT JOIN "User" u ON u.id = s."cleanerUserId"
        LEFT JOIN LATERAL (
          SELECT SUM(sl.quantity * COALESCE(i."costPrice", 0)) AS cost
          FROM "SaleLine" sl
          LEFT JOIN "Item" i ON i.id = sl."itemId" AND i."deletedAt" IS NULL
          WHERE sl."saleId" = s.id
        ) lc ON TRUE
        WHERE s."tenantId" = ${tenantId}
          AND s."deletedAt" IS NULL
          AND s.status::text <> 'draft'
          AND s.date >= ${fromDate}
          AND s.date <= ${toDate}
        GROUP BY 1
        ORDER BY (SUM(s.total) - COALESCE(SUM(lc.cost), 0)) DESC
        LIMIT 100
      `;
      return {
        columns: [
          { key: 'staff', header: 'Service Staff' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGross(
          rows.map((row) => {
            const revenue = money(row.revenue);
            const cost = money(row.cost);
            return {
              staff: row.label,
              grossProfit: gross(revenue, cost),
              revenue,
            };
          }),
        ),
      };
    }
    case 'invoice': {
      const rows = await db.$queryRaw<AggRow[]>`
        SELECT
          s.reference AS reference,
          s.reference AS label,
          s.total AS revenue,
          COALESCE(lc.cost, 0) AS cost
        FROM "Sale" s
        LEFT JOIN LATERAL (
          SELECT SUM(sl.quantity * COALESCE(i."costPrice", 0)) AS cost
          FROM "SaleLine" sl
          LEFT JOIN "Item" i ON i.id = sl."itemId" AND i."deletedAt" IS NULL
          WHERE sl."saleId" = s.id
        ) lc ON TRUE
        WHERE s."tenantId" = ${tenantId}
          AND s."deletedAt" IS NULL
          AND s.status::text <> 'draft'
          AND s.date >= ${fromDate}
          AND s.date <= ${toDate}
        ORDER BY s.date DESC
        LIMIT 200
      `;
      return {
        columns: [
          { key: 'reference', header: 'Invoice' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGross(
          rows.map((row) => {
            const revenue = money(row.revenue);
            const cost = money(row.cost);
            return {
              reference: row.reference ?? row.label,
              grossProfit: gross(revenue, cost),
              revenue,
            };
          }),
        ),
      };
    }
    case 'date':
    case 'day': {
      const rows = await db.$queryRaw<AggRow[]>`
        SELECT
          TO_CHAR(date_trunc('day', s.date), 'YYYY-MM-DD') AS label,
          SUM(s.total) AS revenue,
          COALESCE(SUM(lc.cost), 0) AS cost
        FROM "Sale" s
        LEFT JOIN LATERAL (
          SELECT SUM(sl.quantity * COALESCE(i."costPrice", 0)) AS cost
          FROM "SaleLine" sl
          LEFT JOIN "Item" i ON i.id = sl."itemId" AND i."deletedAt" IS NULL
          WHERE sl."saleId" = s.id
        ) lc ON TRUE
        WHERE s."tenantId" = ${tenantId}
          AND s."deletedAt" IS NULL
          AND s.status::text <> 'draft'
          AND s.date >= ${fromDate}
          AND s.date <= ${toDate}
        GROUP BY date_trunc('day', s.date)
        ORDER BY date_trunc('day', s.date) DESC
      `;
      const mapped = rows.map((row) => {
        const revenue = money(row.revenue);
        const cost = money(row.cost);
        return {
          date: row.label,
          day: row.label,
          grossProfit: gross(revenue, cost),
          revenue,
        };
      });
      if (tab === 'day') {
        return {
          columns: [
            { key: 'day', header: 'Day' },
            { key: 'grossProfit', header: 'Gross Profit' },
          ],
          rows: mapped.map(({ day, grossProfit }) => ({ day, grossProfit })),
        };
      }
      return {
        columns: [
          { key: 'date', header: 'Date' },
          { key: 'grossProfit', header: 'Gross Profit' },
        ],
        rows: mapped.map(({ date, grossProfit, revenue }) => ({
          date,
          grossProfit,
          revenue,
        })),
      };
    }
    default: {
      const _never: never = tab;
      return {
        columns: [{ key: 'label', header: '—' }],
        rows: [{ label: String(_never) }],
      };
    }
  }
}
