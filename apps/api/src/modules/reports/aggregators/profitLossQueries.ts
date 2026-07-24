import type {
  ProfitLossBreakdownTab,
  ProfitLossLine,
  ProfitLossReport,
  ProfitLossSummary,
  ReportsTable,
} from '@vonos/types';
import { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { ledgerDateFilter } from '../../../common/utils/ledgerAggregates';
import { computeSalesRevenueTotal } from '../../../common/utils/salesRevenue';
import { toNumber } from '../../../common/utils/serializers';
import { resolveDateWindow } from './date-utils';
import {
  computeJobRevenueTotal,
  loadJobReportContext,
  type NormalizedJobSale,
} from './jobSalesData';
import {
  loadPeriodSalesOnly,
  type NormalizedSale,
  type SalesReportContext,
} from './salesData';
import { queryProfitLossBreakdownTab } from './profitLossBreakdownSql';

function lineAmount(label: string, key: string, amount: number): ProfitLossLine {
  return { key, label, amount: Math.round(amount * 100) / 100 };
}

async function stockValuation(
  db: TenantScopedPrisma,
  tenantId: string,
): Promise<{ byPurchase: number; bySale: number; currency: string }> {
  const rows = await db.$queryRaw<
    [{ by_purchase: Prisma.Decimal | null; by_sale: Prisma.Decimal | null; currency: string | null }]
  >`
    SELECT
      COALESCE(SUM(quantity * "costPrice"), 0) AS by_purchase,
      COALESCE(SUM(quantity * COALESCE("sellPrice", "costPrice")), 0) AS by_sale,
      (SELECT currency FROM "Item"
       WHERE "deletedAt" IS NULL AND "tenantId" = ${tenantId}
       ORDER BY id ASC LIMIT 1) AS currency
    FROM "Item"
    WHERE "deletedAt" IS NULL AND "tenantId" = ${tenantId}
  `;

  return {
    byPurchase: toNumber(rows[0]?.by_purchase ?? 0),
    bySale: toNumber(rows[0]?.by_sale ?? 0),
    currency: rows[0]?.currency ?? 'NGN',
  };
}

/** Expand StockMovement JSON lines for a subset of movement types. */
async function sumMovementJsonByTypes(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
  types: Array<'inbound' | 'transfer' | 'outbound'>,
): Promise<Map<string, number>> {
  if (types.length === 0) return new Map();
  const typeList = Prisma.join(types.map((t) => Prisma.sql`${t}`));
  const rows = await db.$queryRaw<
    Array<{ type: string; val: Prisma.Decimal | null }>
  >`
    SELECT sm.type::text AS type, COALESCE(SUM(
      CASE
        WHEN elem->>'lineTotal' IS NOT NULL AND elem->>'lineTotal' <> ''
          THEN (elem->>'lineTotal')::numeric
        ELSE
          COALESCE((elem->>'quantity')::numeric, 0)
          * COALESCE((elem->>'unitCost')::numeric, 0)
      END
    ), 0) AS val
    FROM "StockMovement" sm
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(sm.lines::jsonb) = 'array' THEN sm.lines::jsonb
        ELSE '[]'::jsonb
      END
    ) AS elem
    WHERE sm."deletedAt" IS NULL
      AND sm."tenantId" = ${tenantId}
      AND sm.date >= ${from}
      AND sm.date <= ${to}
      AND sm.type::text IN (${typeList})
    GROUP BY sm.type
  `;

  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.type, toNumber(row.val ?? 0));
  }
  return totals;
}

/**
 * Purchase totals from Invoice (indexed); transfer/outbound still need JSON.
 * Falls back to inbound JSON when no purchase invoices exist for the window.
 */
async function sumMovementValuesByType(
  db: TenantScopedPrisma,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<{ inbound: number; transfer: number; outbound: number }> {
  const [purchaseAgg, transferOutbound] = await Promise.all([
    db.invoice.aggregate({
      where: {
        deletedAt: null,
        kind: 'purchase',
        documentDate: { gte: from, lte: to },
      },
      _sum: { total: true },
    }),
    sumMovementJsonByTypes(db, tenantId, from, to, ['transfer', 'outbound']),
  ]);
  const invoicePurchase = toNumber(purchaseAgg._sum.total ?? 0);

  let inbound = invoicePurchase;
  if (invoicePurchase <= 0) {
    const inboundOnly = await sumMovementJsonByTypes(db, tenantId, from, to, [
      'inbound',
    ]);
    inbound = inboundOnly.get('inbound') ?? 0;
  }

  return {
    inbound,
    transfer: transferOutbound.get('transfer') ?? 0,
    outbound: transferOutbound.get('outbound') ?? 0,
  };
}

async function totalPayroll(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<number> {
  const payrollMonthFilter =
    from || to
      ? {
          payrollMonth: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          },
        }
      : {};

  const payrollRows = await db.payroll.aggregate({
    where: { deletedAt: null, ...payrollMonthFilter },
    _sum: { netPay: true },
  });
  const fromPayroll = toNumber(payrollRows._sum.netPay ?? 0);
  if (fromPayroll > 0) return fromPayroll;

  const dateFilter = ledgerDateFilter(from, to);
  const ledgerPayroll = await db.ledgerEntry.aggregate({
    where: {
      deletedAt: null,
      type: 'expense',
      category: { contains: 'payroll', mode: 'insensitive' },
      ...dateFilter,
    },
    _sum: { amount: true },
  });
  return toNumber(ledgerPayroll._sum.amount ?? 0);
}

type ItemMeta = { cost: number; category: string | null; brandName: string | null };

function lineUnitCost(
  itemId: string | null | undefined,
  itemMeta: Map<string, ItemMeta>,
): number {
  if (!itemId) return 0;
  return itemMeta.get(itemId)?.cost ?? 0;
}

function lineCategory(
  itemId: string | null | undefined,
  itemMeta: Map<string, ItemMeta>,
): string {
  if (!itemId) return 'Uncategorized';
  return itemMeta.get(itemId)?.category?.trim() || 'Uncategorized';
}

function lineBrand(
  itemId: string | null | undefined,
  itemMeta: Map<string, ItemMeta>,
): string {
  if (!itemId) return 'Unbranded';
  return itemMeta.get(itemId)?.brandName?.trim() || 'Unbranded';
}

function addBucket(
  map: Map<string, { revenue: number; cost: number }>,
  key: string,
  revenue: number,
  cost: number,
) {
  const bucket = map.get(key) ?? { revenue: 0, cost: 0 };
  bucket.revenue += revenue;
  bucket.cost += cost;
  map.set(key, bucket);
}

function mergeJobIntoBreakdowns(
  job: NormalizedJobSale,
  maps: {
    byDate: Map<string, { revenue: number; cost: number }>;
    byCustomer: Map<string, { revenue: number; cost: number }>;
    byLocation: Map<string, { revenue: number; cost: number }>;
    byStaff: Map<string, { revenue: number; cost: number }>;
    byCategory: Map<string, { revenue: number; cost: number }>;
    byProduct: Map<
      string,
      { label: string; revenue: number; cost: number; units: number }
    >;
    byBrand: Map<string, { revenue: number; cost: number }>;
    byInvoice: Array<{
      reference: string;
      revenue: number;
      cost: number;
      date: Date;
    }>;
  },
  itemMeta: Map<string, ItemMeta>,
) {
  const dateKey = job.date.toISOString().slice(0, 10);
  const customerKey = job.customerName.trim() || 'Walk-in';
  const locationKey = job.locationCode?.trim() || 'Default';
  const staffKey = job.staffName?.trim() || 'Unassigned';

  addBucket(maps.byDate, dateKey, job.revenue, job.directCost);
  addBucket(maps.byCustomer, customerKey, job.revenue, job.directCost);
  addBucket(maps.byLocation, locationKey, job.revenue, job.directCost);
  addBucket(maps.byStaff, staffKey, job.revenue, job.directCost);
  addBucket(maps.byCategory, 'Job Services', job.revenue, job.directCost);

  const materialCost = job.materials.reduce((sum, line) => sum + line.cost, 0);
  const allocBase = materialCost + job.labourCost;

  if (job.labourCost > 0) {
    const labourRevenue =
      allocBase > 0 ? job.revenue * (job.labourCost / allocBase) : 0;
    const labour = maps.byProduct.get('job-labour') ?? {
      label: 'Labour',
      revenue: 0,
      cost: 0,
      units: 0,
    };
    labour.revenue += labourRevenue;
    labour.cost += job.labourCost;
    labour.units += 1;
    maps.byProduct.set('job-labour', labour);
    addBucket(maps.byBrand, 'Services', labourRevenue, job.labourCost);
  }

  for (const line of job.materials) {
    const lineRevenue =
      allocBase > 0 ? job.revenue * (line.cost / allocBase) : 0;
    const productKey = `job-${line.name}`;
    const product = maps.byProduct.get(productKey) ?? {
      label: line.name,
      revenue: 0,
      cost: 0,
      units: 0,
    };
    product.revenue += lineRevenue;
    product.cost += line.cost;
    product.units += line.quantity;
    maps.byProduct.set(productKey, product);
    addBucket(
      maps.byBrand,
      lineBrand(line.itemId, itemMeta),
      lineRevenue,
      line.cost,
    );
  }

  maps.byInvoice.push({
    reference: job.reference,
    revenue: job.revenue,
    cost: job.directCost,
    date: job.date,
  });
}

function buildBreakdowns(
  ctx: SalesReportContext,
  jobCtx: Awaited<ReturnType<typeof loadJobReportContext>>,
  itemMeta: Map<string, ItemMeta>,
): Partial<Record<ProfitLossBreakdownTab, ReportsTable>> {
  const byDate = new Map<string, { revenue: number; cost: number }>();
  const byProduct = new Map<
    string,
    { label: string; revenue: number; cost: number; units: number }
  >();
  const byCustomer = new Map<string, { revenue: number; cost: number }>();
  const byLocation = new Map<string, { revenue: number; cost: number }>();
  const byStaff = new Map<string, { revenue: number; cost: number }>();
  const byCategory = new Map<string, { revenue: number; cost: number }>();
  const byBrand = new Map<string, { revenue: number; cost: number }>();
  const byInvoice: Array<{
    reference: string;
    revenue: number;
    cost: number;
    date: Date;
  }> = [];

  for (const sale of ctx.periodSales) {
    const dateKey = sale.date.toISOString().slice(0, 10);
    const dayBucket = byDate.get(dateKey) ?? { revenue: 0, cost: 0 };
    dayBucket.revenue += sale.total;

    const customerKey = sale.customerName.trim() || 'Walk-in';
    const customerBucket = byCustomer.get(customerKey) ?? {
      revenue: 0,
      cost: 0,
    };
    customerBucket.revenue += sale.total;

    const locationKey = sale.locationCode?.trim() || 'Default';
    const locationBucket = byLocation.get(locationKey) ?? {
      revenue: 0,
      cost: 0,
    };
    locationBucket.revenue += sale.total;

    const staffKey = sale.staffName?.trim() || 'Unassigned';
    const staffBucket = byStaff.get(staffKey) ?? { revenue: 0, cost: 0 };
    staffBucket.revenue += sale.total;

    let invoiceCost = 0;

    for (const line of sale.lines) {
      const qty = toNumber(line.quantity);
      const revenue = toNumber(line.lineTotal);
      const unitCost = lineUnitCost(line.itemId, itemMeta);
      const cost = qty * unitCost;

      dayBucket.cost += cost;
      customerBucket.cost += cost;
      locationBucket.cost += cost;
      staffBucket.cost += cost;
      invoiceCost += cost;

      const categoryKey = lineCategory(line.itemId, itemMeta);
      addBucket(byCategory, categoryKey, revenue, cost);
      addBucket(byBrand, lineBrand(line.itemId, itemMeta), revenue, cost);

      const sku = line.sku?.trim() || line.name;
      const product = byProduct.get(sku) ?? {
        label: line.name,
        revenue: 0,
        cost: 0,
        units: 0,
      };
      product.revenue += revenue;
      product.cost += cost;
      product.units += qty;
      byProduct.set(sku, product);
    }

    byDate.set(dateKey, dayBucket);
    byCustomer.set(customerKey, customerBucket);
    byLocation.set(locationKey, locationBucket);
    byStaff.set(staffKey, staffBucket);
    byInvoice.push({
      reference: sale.reference,
      revenue: sale.total,
      cost: invoiceCost,
      date: sale.date,
    });
  }

  const jobMaps = {
    byDate,
    byCustomer,
    byLocation,
    byStaff,
    byCategory,
    byProduct,
    byBrand,
    byInvoice,
  };
  for (const job of jobCtx.periodJobs) {
    mergeJobIntoBreakdowns(job, jobMaps, itemMeta);
  }

  const grossRow = (revenue: number, cost: number) =>
    Math.round((revenue - cost) * 100) / 100;

  const sortByGrossProfit = <T extends { grossProfit: number }>(rows: T[]) =>
    rows.sort((a, b) => b.grossProfit - a.grossProfit);

  const dateRows = Array.from(byDate.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, row]) => ({
      date,
      grossProfit: grossRow(row.revenue, row.cost),
      revenue: Math.round(row.revenue * 100) / 100,
    }));

  const productRows = sortByGrossProfit(
    Array.from(byProduct.values()).map((row) => ({
      product: row.label,
      unitsSold: row.units,
      grossProfit: grossRow(row.revenue, row.cost),
      revenue: Math.round(row.revenue * 100) / 100,
    })),
  );

  const categoryRows = sortByGrossProfit(
    Array.from(byCategory.entries()).map(([category, row]) => ({
      category,
      grossProfit: grossRow(row.revenue, row.cost),
      revenue: Math.round(row.revenue * 100) / 100,
    })),
  );

  const customerRows = sortByGrossProfit(
    Array.from(byCustomer.entries()).map(([customer, row]) => ({
      customer,
      grossProfit: grossRow(row.revenue, row.cost),
      revenue: Math.round(row.revenue * 100) / 100,
    })),
  );

  const locationRows = sortByGrossProfit(
    Array.from(byLocation.entries()).map(([location, row]) => ({
      location,
      grossProfit: grossRow(row.revenue, row.cost),
      revenue: Math.round(row.revenue * 100) / 100,
    })),
  );

  const staffRows = sortByGrossProfit(
    Array.from(byStaff.entries()).map(([staff, row]) => ({
      staff,
      grossProfit: grossRow(row.revenue, row.cost),
      revenue: Math.round(row.revenue * 100) / 100,
    })),
  );

  const brandRows = sortByGrossProfit(
    Array.from(byBrand.entries()).map(([brand, row]) => ({
      brand,
      grossProfit: grossRow(row.revenue, row.cost),
      revenue: Math.round(row.revenue * 100) / 100,
    })),
  );

  const invoiceRows = sortByGrossProfit(
    byInvoice
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 200)
      .map((row) => ({
        reference: row.reference,
        grossProfit: grossRow(row.revenue, row.cost),
        revenue: Math.round(row.revenue * 100) / 100,
      })),
  );

  return {
    date: {
      columns: [
        { key: 'date', header: 'Date' },
        { key: 'grossProfit', header: 'Gross Profit' },
      ],
      rows: dateRows,
    },
    product: {
      columns: [
        { key: 'product', header: 'Product' },
        { key: 'unitsSold', header: 'Units Sold' },
        { key: 'grossProfit', header: 'Gross Profit' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows: productRows,
    },
    category: {
      columns: [
        { key: 'category', header: 'Category' },
        { key: 'grossProfit', header: 'Gross Profit' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows: categoryRows,
    },
    invoice: {
      columns: [
        { key: 'reference', header: 'Invoice' },
        { key: 'grossProfit', header: 'Gross Profit' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows: invoiceRows,
    },
    customer: {
      columns: [
        { key: 'customer', header: 'Customer' },
        { key: 'grossProfit', header: 'Gross Profit' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows: customerRows,
    },
    brand: {
      columns: [
        { key: 'brand', header: 'Brand' },
        { key: 'grossProfit', header: 'Gross Profit' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows: brandRows,
    },
    location: {
      columns: [
        { key: 'location', header: 'Location' },
        { key: 'grossProfit', header: 'Gross Profit' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows: locationRows,
    },
    day: {
      columns: [
        { key: 'day', header: 'Day' },
        { key: 'grossProfit', header: 'Gross Profit' },
      ],
      rows: dateRows.map((r) => ({
        day: r.date,
        grossProfit: r.grossProfit,
      })),
    },
    'service-staff': {
      columns: [
        { key: 'staff', header: 'Service Staff' },
        { key: 'grossProfit', header: 'Gross Profit' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows: staffRows,
    },
  };
}

function buildBreakdownForTab(
  tab: ProfitLossBreakdownTab,
  ctx: SalesReportContext,
  jobCtx: Awaited<ReturnType<typeof loadJobReportContext>>,
  itemMeta: Map<string, ItemMeta>,
): ReportsTable {
  const byDate = new Map<string, { revenue: number; cost: number }>();
  const byProduct = new Map<
    string,
    { label: string; revenue: number; cost: number; units: number }
  >();
  const byCustomer = new Map<string, { revenue: number; cost: number }>();
  const byLocation = new Map<string, { revenue: number; cost: number }>();
  const byStaff = new Map<string, { revenue: number; cost: number }>();
  const byCategory = new Map<string, { revenue: number; cost: number }>();
  const byBrand = new Map<string, { revenue: number; cost: number }>();
  const byInvoice: Array<{
    reference: string;
    revenue: number;
    cost: number;
    date: Date;
  }> = [];

  const needsDate = tab === 'date' || tab === 'day';
  const needsProduct = tab === 'product';
  const needsCategory = tab === 'category';
  const needsInvoice = tab === 'invoice';
  const needsCustomer = tab === 'customer';
  const needsBrand = tab === 'brand';
  const needsLocation = tab === 'location';
  const needsStaff = tab === 'service-staff';

  for (const sale of ctx.periodSales) {
    const dateKey = sale.date.toISOString().slice(0, 10);
    const customerKey = sale.customerName.trim() || 'Walk-in';
    const locationKey = sale.locationCode?.trim() || 'Default';
    const staffKey = sale.staffName?.trim() || 'Unassigned';

    const dayBucket = needsDate ? byDate.get(dateKey) ?? { revenue: 0, cost: 0 } : null;
    const customerBucket = needsCustomer
      ? byCustomer.get(customerKey) ?? { revenue: 0, cost: 0 }
      : null;
    const locationBucket = needsLocation
      ? byLocation.get(locationKey) ?? { revenue: 0, cost: 0 }
      : null;
    const staffBucket = needsStaff
      ? byStaff.get(staffKey) ?? { revenue: 0, cost: 0 }
      : null;

    if (dayBucket) dayBucket.revenue += sale.total;
    if (customerBucket) customerBucket.revenue += sale.total;
    if (locationBucket) locationBucket.revenue += sale.total;
    if (staffBucket) staffBucket.revenue += sale.total;

    let invoiceCost = 0;

    for (const line of sale.lines) {
      const qty = toNumber(line.quantity);
      const revenue = toNumber(line.lineTotal);
      const unitCost = lineUnitCost(line.itemId, itemMeta);
      const cost = qty * unitCost;

      if (dayBucket) dayBucket.cost += cost;
      if (customerBucket) customerBucket.cost += cost;
      if (locationBucket) locationBucket.cost += cost;
      if (staffBucket) staffBucket.cost += cost;
      if (needsInvoice) invoiceCost += cost;

      if (needsCategory) {
        addBucket(byCategory, lineCategory(line.itemId, itemMeta), revenue, cost);
      }
      if (needsBrand) {
        addBucket(byBrand, lineBrand(line.itemId, itemMeta), revenue, cost);
      }
      if (needsProduct) {
        const sku = line.sku?.trim() || line.name;
        const product = byProduct.get(sku) ?? {
          label: line.name,
          revenue: 0,
          cost: 0,
          units: 0,
        };
        product.revenue += revenue;
        product.cost += cost;
        product.units += qty;
        byProduct.set(sku, product);
      }
    }

    if (dayBucket) byDate.set(dateKey, dayBucket);
    if (customerBucket) byCustomer.set(customerKey, customerBucket);
    if (locationBucket) byLocation.set(locationKey, locationBucket);
    if (staffBucket) byStaff.set(staffKey, staffBucket);
    if (needsInvoice) {
      byInvoice.push({
        reference: sale.reference,
        revenue: sale.total,
        cost: invoiceCost,
        date: sale.date,
      });
    }
  }

  // Jobs may contribute to all dimensions; merge once to keep parity with full report logic.
  const jobMaps = {
    byDate,
    byCustomer,
    byLocation,
    byStaff,
    byCategory,
    byProduct,
    byBrand,
    byInvoice,
  };
  for (const job of jobCtx.periodJobs) {
    mergeJobIntoBreakdowns(job, jobMaps, itemMeta);
  }

  const grossRow = (revenue: number, cost: number) =>
    Math.round((revenue - cost) * 100) / 100;

  const sortByGrossProfit = <T extends { grossProfit: number }>(rows: T[]) =>
    rows.sort((a, b) => b.grossProfit - a.grossProfit);

  switch (tab) {
    case 'date': {
      const rows = Array.from(byDate.entries())
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([date, row]) => ({
          date,
          grossProfit: grossRow(row.revenue, row.cost),
          revenue: Math.round(row.revenue * 100) / 100,
        }));
      return {
        columns: [
          { key: 'date', header: 'Date' },
          { key: 'grossProfit', header: 'Gross Profit' },
        ],
        rows,
      };
    }
    case 'product':
      return {
        columns: [
          { key: 'product', header: 'Product' },
          { key: 'unitsSold', header: 'Units Sold' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGrossProfit(
          Array.from(byProduct.values()).map((row) => ({
            product: row.label,
            unitsSold: row.units,
            grossProfit: grossRow(row.revenue, row.cost),
            revenue: Math.round(row.revenue * 100) / 100,
          })),
        ),
      };
    case 'category':
      return {
        columns: [
          { key: 'category', header: 'Category' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGrossProfit(
          Array.from(byCategory.entries()).map(([category, row]) => ({
            category,
            grossProfit: grossRow(row.revenue, row.cost),
            revenue: Math.round(row.revenue * 100) / 100,
          })),
        ),
      };
    case 'invoice':
      return {
        columns: [
          { key: 'reference', header: 'Invoice' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGrossProfit(
          byInvoice
            .sort((a, b) => b.date.getTime() - a.date.getTime())
            .slice(0, 200)
            .map((row) => ({
              reference: row.reference,
              grossProfit: grossRow(row.revenue, row.cost),
              revenue: Math.round(row.revenue * 100) / 100,
            })),
        ),
      };
    case 'customer':
      return {
        columns: [
          { key: 'customer', header: 'Customer' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGrossProfit(
          Array.from(byCustomer.entries()).map(([customer, row]) => ({
            customer,
            grossProfit: grossRow(row.revenue, row.cost),
            revenue: Math.round(row.revenue * 100) / 100,
          })),
        ),
      };
    case 'brand':
      return {
        columns: [
          { key: 'brand', header: 'Brand' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGrossProfit(
          Array.from(byBrand.entries()).map(([brand, row]) => ({
            brand,
            grossProfit: grossRow(row.revenue, row.cost),
            revenue: Math.round(row.revenue * 100) / 100,
          })),
        ),
      };
    case 'location':
      return {
        columns: [
          { key: 'location', header: 'Location' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGrossProfit(
          Array.from(byLocation.entries()).map(([location, row]) => ({
            location,
            grossProfit: grossRow(row.revenue, row.cost),
            revenue: Math.round(row.revenue * 100) / 100,
          })),
        ),
      };
    case 'day': {
      const rows = Array.from(byDate.entries())
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([day, row]) => ({
          day,
          grossProfit: grossRow(row.revenue, row.cost),
        }));
      return {
        columns: [
          { key: 'day', header: 'Day' },
          { key: 'grossProfit', header: 'Gross Profit' },
        ],
        rows,
      };
    }
    case 'service-staff':
      return {
        columns: [
          { key: 'staff', header: 'Service Staff' },
          { key: 'grossProfit', header: 'Gross Profit' },
          { key: 'revenue', header: 'Revenue' },
        ],
        rows: sortByGrossProfit(
          Array.from(byStaff.entries()).map(([staff, row]) => ({
            staff,
            grossProfit: grossRow(row.revenue, row.cost),
            revenue: Math.round(row.revenue * 100) / 100,
          })),
        ),
      };
    default: {
      const _never: never = tab;
      return {
        columns: [{ key: 'label', header: '—' }],
        rows: [{ label: _never }],
      };
    }
  }
}

export interface ProfitLossLoadContext {
  stock: { byPurchase: number; bySale: number; currency: string };
  ledgerGroups: Array<{
    type: string;
    category: string | null;
    _sum: { amount: Prisma.Decimal | null };
  }>;
  salesRevenue: { revenue: number; currency: string };
  payrollTotal: number;
  /** Pre-aggregated movement line totals (SQL). */
  inboundTotal: number;
  transferTotal: number;
  outboundTotal: number;
  saleDiscountTotal: number;
  returnSalesTotal: number;
  /** Present when includeBreakdown was requested (or full load). */
  ctx: SalesReportContext;
  jobCtx: Awaited<ReturnType<typeof loadJobReportContext>>;
  itemMeta: Map<string, ItemMeta>;
  jobTotals: { revenue: number; directCost: number };
  hasBreakdownData: boolean;
}

export type LoadProfitLossOptions = {
  /** When false, skip sale/job graphs (summary / pl-core only). Default true for full report. */
  includeBreakdown?: boolean;
};

function emptySalesContext(
  window: ReturnType<typeof resolveDateWindow>,
  currency: string,
): SalesReportContext {
  return {
    window,
    prior: window,
    periodSales: [],
    priorSales: [],
    currency,
  };
}

function emptyJobContext(
  window: ReturnType<typeof resolveDateWindow>,
): Awaited<ReturnType<typeof loadJobReportContext>> {
  return { window, periodJobs: [], currency: 'NGN' };
}

async function loadBreakdownGraphs(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<{
  ctx: SalesReportContext;
  jobCtx: Awaited<ReturnType<typeof loadJobReportContext>>;
  itemMeta: Map<string, ItemMeta>;
  jobTotals: { revenue: number; directCost: number };
}> {
  const [salesCtx, jobCtx] = await Promise.all([
    loadPeriodSalesOnly(db, from, to),
    loadJobReportContext(db, from, to),
  ]);

  const ctx: SalesReportContext = {
    window: salesCtx.window,
    prior: salesCtx.window,
    periodSales: salesCtx.periodSales,
    priorSales: [],
    currency: salesCtx.currency,
  };

  const itemIds = new Set<string>();
  for (const sale of salesCtx.periodSales) {
    for (const line of sale.lines) {
      if (line.itemId) itemIds.add(line.itemId);
    }
  }
  for (const job of jobCtx.periodJobs) {
    for (const material of job.materials) {
      if (material.itemId) itemIds.add(material.itemId);
    }
  }

  const items =
    itemIds.size > 0
      ? await db.item.findMany({
          where: { deletedAt: null, id: { in: [...itemIds] } },
          select: {
            id: true,
            costPrice: true,
            category: true,
            brand: { select: { name: true } },
          },
        })
      : [];

  const itemMeta = new Map<string, ItemMeta>(
    items.map((item) => [
      item.id,
      {
        cost: toNumber(item.costPrice),
        category: item.category,
        brandName: item.brand?.name ?? null,
      },
    ]),
  );

  const jobTotals = jobCtx.periodJobs.reduce(
    (acc, job) => ({
      revenue: acc.revenue + job.revenue,
      directCost: acc.directCost + job.directCost,
    }),
    { revenue: 0, directCost: 0 },
  );

  return { ctx, jobCtx, itemMeta, jobTotals };
}

/** Load P&L inputs. Stock valuation is SQL-only and safe to parallelize with aggregates. */
export async function loadProfitLossContext(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  options: LoadProfitLossOptions = {},
): Promise<ProfitLossLoadContext> {
  const includeBreakdown = options.includeBreakdown ?? true;
  const window = resolveDateWindow(from, to);
  const dateFilter = ledgerDateFilter(from, to);

  const [
    stock,
    ledgerGroups,
    salesRevenue,
    payrollTotal,
    movementTotals,
    saleDiscountAgg,
    returnSales,
    jobTotalsAgg,
  ] = await Promise.all([
    stockValuation(db, tenantId),
    db.ledgerEntry.groupBy({
      by: ['type', 'category'],
      where: { deletedAt: null, ...dateFilter },
      _sum: { amount: true },
    }),
    computeSalesRevenueTotal(db, from, to),
    totalPayroll(db, from, to),
    sumMovementValuesByType(db, tenantId, window.from, window.to),
    db.sale.aggregate({
      where: {
        deletedAt: null,
        date: { gte: window.from, lte: window.to },
      },
      _sum: { discountAmount: true },
    }),
    db.sale.aggregate({
      where: {
        deletedAt: null,
        status: { in: ['refunded', 'partially_refunded', 'written_off'] },
        date: { gte: window.from, lte: window.to },
      },
      _sum: { total: true },
    }),
    includeBreakdown
      ? Promise.resolve({ revenue: 0, directCost: 0 })
      : computeJobRevenueTotal(db, tenantId, from, to),
  ]);

  const inboundTotal = movementTotals.inbound;
  const transferTotal = movementTotals.transfer;
  const outboundTotal = movementTotals.outbound;

  let ctx = emptySalesContext(window, salesRevenue.currency);
  let jobCtx = emptyJobContext(window);
  let itemMeta = new Map<string, ItemMeta>();
  let jobTotals = jobTotalsAgg;
  let hasBreakdownData = false;

  if (includeBreakdown) {
    const graphs = await loadBreakdownGraphs(db, from, to);
    ctx = graphs.ctx;
    jobCtx = graphs.jobCtx;
    itemMeta = graphs.itemMeta;
    jobTotals = graphs.jobTotals;
    hasBreakdownData = true;
  }

  return {
    stock,
    ledgerGroups,
    salesRevenue,
    payrollTotal,
    inboundTotal,
    transferTotal,
    outboundTotal,
    saleDiscountTotal: toNumber(saleDiscountAgg._sum.discountAmount ?? 0),
    returnSalesTotal: toNumber(returnSales._sum.total ?? 0),
    ctx,
    jobCtx,
    itemMeta,
    jobTotals,
    hasBreakdownData,
  };
}

/** Ensure sale/job graphs are present (for pl-breakdown after a summary-only cache hit). */
export async function ensureProfitLossBreakdownData(
  db: TenantScopedPrisma,
  loaded: ProfitLossLoadContext,
  from?: string,
  to?: string,
): Promise<ProfitLossLoadContext> {
  if (loaded.hasBreakdownData) return loaded;
  const graphs = await loadBreakdownGraphs(db, from, to);
  return {
    ...loaded,
    ...graphs,
    hasBreakdownData: true,
  };
}

export function buildProfitLossSummaryFromContext(
  loaded: ProfitLossLoadContext,
): ProfitLossSummary {
  const {
    stock,
    ledgerGroups,
    salesRevenue,
    payrollTotal,
    inboundTotal,
    transferTotal,
    outboundTotal,
    saleDiscountTotal,
    returnSalesTotal,
    jobTotals,
  } = loaded;

  const currency = stock.currency || salesRevenue.currency || 'NGN';

  let totalExpense = 0;
  for (const group of ledgerGroups) {
    if (group.type !== 'expense') continue;
    const cat = (group.category ?? '').toLowerCase();
    if (cat.includes('payroll')) continue;
    totalExpense += toNumber(group._sum.amount ?? 0);
  }

  const totalPurchase = inboundTotal;
  const totalStockAdjustment = 0;
  const totalTransferShipping = transferTotal;
  const totalSellDiscount = saleDiscountTotal;
  const totalSellReturn = returnSalesTotal;
  const totalSales = salesRevenue.revenue + jobTotals.revenue;

  const closingStockPurchase = stock.byPurchase;
  const closingStockSale = stock.bySale;

  const outboundCost = outboundTotal;
  const openingStockPurchase = Math.max(
    0,
    closingStockPurchase - totalPurchase + outboundCost,
  );
  const openingStockSale = Math.max(
    0,
    closingStockSale - totalPurchase * 1.1 + totalSales * 0.1,
  );

  const debits: ProfitLossLine[] = [
    lineAmount(
      'Opening Stock (By purchase price)',
      'openingStockPurchase',
      openingStockPurchase,
    ),
    lineAmount(
      'Opening Stock (By sale price)',
      'openingStockSale',
      openingStockSale,
    ),
    lineAmount('Total purchase', 'totalPurchase', totalPurchase),
    lineAmount('Total Stock Adjustment', 'totalStockAdjustment', totalStockAdjustment),
    lineAmount('Total Expense', 'totalExpense', totalExpense),
    lineAmount('Total purchase shipping charge', 'purchaseShipping', 0),
    lineAmount('Purchase additional expenses', 'purchaseAdditional', 0),
    lineAmount('Total transfer shipping charge', 'transferShipping', totalTransferShipping),
    lineAmount('Total Sell discount', 'sellDiscount', totalSellDiscount),
    lineAmount('Total customer reward', 'customerReward', 0),
    lineAmount('Total Sell Return', 'sellReturn', totalSellReturn),
    lineAmount('Total Payroll', 'totalPayroll', payrollTotal),
  ];

  const credits: ProfitLossLine[] = [
    lineAmount(
      'Closing stock (By purchase price)',
      'closingStockPurchase',
      closingStockPurchase,
    ),
    lineAmount(
      'Closing stock (By sale price)',
      'closingStockSale',
      closingStockSale,
    ),
    lineAmount('Total Sales', 'totalSales', totalSales),
    lineAmount('Total sell shipping charge', 'sellShipping', 0),
    lineAmount('Sell additional expenses', 'sellAdditional', 0),
    lineAmount('Total Stock Recovered', 'stockRecovered', 0),
    lineAmount('Total Purchase Return', 'purchaseReturn', 0),
    lineAmount('Total Purchase discount', 'purchaseDiscount', 0),
    lineAmount('Total sell reward', 'sellReward', 0),
  ];

  const cogs =
    openingStockPurchase +
    totalPurchase +
    totalStockAdjustment +
    totalTransferShipping -
    closingStockPurchase +
    jobTotals.directCost;

  const grossProfit = totalSales - cogs;
  const netProfit =
    grossProfit -
    totalExpense -
    payrollTotal -
    totalSellDiscount -
    totalSellReturn;

  return {
    currency,
    debits,
    credits,
    cogs: Math.round(cogs * 100) / 100,
    grossProfit: Math.round(grossProfit * 100) / 100,
    netProfit: Math.round(netProfit * 100) / 100,
  };
}

export async function buildHqProfitLossSummaryOnly(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  loaded?: ProfitLossLoadContext,
): Promise<ProfitLossSummary> {
  const context =
    loaded ??
    (await loadProfitLossContext(db, tenantId, from, to, {
      includeBreakdown: false,
    }));
  return buildProfitLossSummaryFromContext(context);
}

export async function buildHqProfitLossBreakdownTab(
  db: TenantScopedPrisma,
  tenantId: string,
  from: string | undefined,
  to: string | undefined,
  tab: ProfitLossBreakdownTab,
  _loaded?: ProfitLossLoadContext,
): Promise<ReportsTable> {
  return queryProfitLossBreakdownTab(db, tenantId, tab, from, to);
}

export function buildHqProfitLossFromContext(
  loaded: ProfitLossLoadContext,
): ProfitLossReport {
  return {
    summary: buildProfitLossSummaryFromContext(loaded),
    breakdowns: buildBreakdowns(loaded.ctx, loaded.jobCtx, loaded.itemMeta),
  };
}

export async function buildHqProfitLossReport(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<ProfitLossReport> {
  const loaded = await loadProfitLossContext(db, tenantId, from, to, {
    includeBreakdown: true,
  });
  return buildHqProfitLossFromContext(loaded);
}

/** JSON-safe cache shape for ProfitLossLoadContext (Redis / in-memory). */
export type ProfitLossLoadContextCached = Omit<
  ProfitLossLoadContext,
  'itemMeta' | 'ctx' | 'jobCtx'
> & {
  itemMeta: Array<[string, ItemMeta]>;
  ctx: {
    window: { from: string; to: string };
    prior: { from: string; to: string };
    periodSales: Array<Omit<NormalizedSale, 'date'> & { date: string }>;
    priorSales: [];
    currency: string;
  };
  jobCtx: {
    window: { from: string; to: string };
    periodJobs: Array<Omit<NormalizedJobSale, 'date'> & { date: string }>;
    currency: string;
  };
};

export function serializeProfitLossContext(
  ctx: ProfitLossLoadContext,
): ProfitLossLoadContextCached {
  return {
    ...ctx,
    itemMeta: [...ctx.itemMeta.entries()],
    ctx: {
      window: {
        from: ctx.ctx.window.from.toISOString(),
        to: ctx.ctx.window.to.toISOString(),
      },
      prior: {
        from: ctx.ctx.prior.from.toISOString(),
        to: ctx.ctx.prior.to.toISOString(),
      },
      periodSales: ctx.ctx.periodSales.map((sale) => ({
        ...sale,
        date: sale.date.toISOString(),
      })),
      priorSales: [],
      currency: ctx.ctx.currency,
    },
    jobCtx: {
      window: {
        from: ctx.jobCtx.window.from.toISOString(),
        to: ctx.jobCtx.window.to.toISOString(),
      },
      periodJobs: ctx.jobCtx.periodJobs.map((job) => ({
        ...job,
        date: job.date.toISOString(),
      })),
      currency: ctx.jobCtx.currency,
    },
  };
}

export function deserializeProfitLossContext(
  cached: ProfitLossLoadContextCached,
): ProfitLossLoadContext {
  return {
    ...cached,
    inboundTotal: cached.inboundTotal ?? 0,
    transferTotal: cached.transferTotal ?? 0,
    outboundTotal: cached.outboundTotal ?? 0,
    hasBreakdownData:
      cached.hasBreakdownData ??
      (cached.ctx.periodSales.length > 0 || cached.jobCtx.periodJobs.length > 0),
    itemMeta: new Map(cached.itemMeta),
    ctx: {
      window: {
        from: new Date(cached.ctx.window.from),
        to: new Date(cached.ctx.window.to),
      },
      prior: {
        from: new Date(cached.ctx.prior.from),
        to: new Date(cached.ctx.prior.to),
      },
      periodSales: cached.ctx.periodSales.map((sale) => ({
        ...sale,
        date: new Date(sale.date),
      })),
      priorSales: [],
      currency: cached.ctx.currency,
    },
    jobCtx: {
      window: {
        from: new Date(cached.jobCtx.window.from),
        to: new Date(cached.jobCtx.window.to),
      },
      periodJobs: cached.jobCtx.periodJobs.map((job) => ({
        ...job,
        date: new Date(job.date),
      })),
      currency: cached.jobCtx.currency,
    },
  };
}
