import type {
  ReportRowAction,
  ReportRunOptions,
  ReportsDashboard,
  ReportsTable,
  ReportsTableRow,
} from '@vonos/types';
import { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import {
  buildCompositeCursorQuery,
  nextCompositeCursor,
} from '../../../common/utils/pagination';
import { toNumber } from '../../../common/utils/serializers';
import { resolveDateWindow } from './date-utils';

const DEFAULT_PAGE = 10;

function pageSizeOf(options?: ReportRunOptions): number {
  return Math.min(Math.max(options?.limit ?? DEFAULT_PAGE, 1), 100);
}

function currencyKpi(
  label: string,
  metricKey: string,
  value: number,
  currency: string,
  color: string,
  icon: string,
) {
  return { label, icon, metricKey, color, value, currency };
}

function countKpi(
  label: string,
  metricKey: string,
  value: number,
  color: string,
  icon: string,
) {
  return { label, icon, metricKey, color, value };
}

function paginateRows<T extends { id: string }>(
  rows: T[],
  pageSize: number,
  sortField: keyof T,
  sortValueType: 'string' | 'date' | 'number' = 'date',
): Pick<ReportsTable, 'hasMore' | 'nextCursor' | 'pageSize'> & { rows: T[] } {
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    hasMore,
    nextCursor:
      hasMore && last
        ? nextCompositeCursor(last, sortField, sortValueType)
        : null,
    pageSize,
  };
}

function saleLineActions(saleId: string): ReportRowAction[] {
  return [
    {
      kind: 'view-record',
      label: 'View',
      payload: { recordType: 'sale', saleId, id: saleId },
    },
  ];
}

function paymentActions(paymentId: string, saleId?: string | null): ReportRowAction[] {
  const actions: ReportRowAction[] = [
    {
      kind: 'view-record',
      label: 'View',
      payload: {
        paymentId,
        recordType: saleId ? 'sale' : 'payment',
        ...(saleId ? { saleId, id: saleId } : {}),
      },
    },
  ];
  if (saleId) {
    actions.push({
      kind: 'edit-payment',
      label: 'Edit payment',
      payload: { paymentId },
    });
  }
  return actions;
}

/** Sell Payment Report — Ultimate POS payment table. */
export async function buildSellPaymentReport(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  options?: ReportRunOptions,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const pageSize = pageSizeOf(options);
  const pagination = buildCompositeCursorQuery({
    sortField: 'createdAt',
    sortDir: 'desc',
    cursor: options?.cursor,
    limit: pageSize + 1,
    sortValueType: 'date',
  });

  const paidOnFilter: Prisma.PaymentWhereInput = {
    OR: [
      { paidOn: { gte: window.from, lte: window.to } },
      {
        paidOn: null,
        createdAt: { gte: window.from, lte: window.to },
      },
    ],
  };

  const filterAnd: Prisma.PaymentWhereInput[] = [
    paidOnFilter,
    {
      OR: [{ saleId: { not: null } }, { paymentFor: null }],
    },
    ...(options?.paymentMethod ? [{ method: options.paymentMethod }] : []),
    ...(options?.customerId
      ? [{ sale: { customerId: options.customerId } }]
      : []),
    ...(options?.customerGroupId
      ? [{ sale: { customer: { customerGroupId: options.customerGroupId } } }]
      : []),
    ...(options?.locationCode
      ? [{ sale: { locationCode: options.locationCode } }]
      : []),
    ...(options?.search
      ? [
          {
            OR: [
              {
                paymentRefNo: {
                  contains: options.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                sale: {
                  reference: {
                    contains: options.search,
                    mode: 'insensitive' as const,
                  },
                },
              },
              {
                sale: {
                  customer: {
                    name: {
                      contains: options.search,
                      mode: 'insensitive' as const,
                    },
                  },
                },
              },
            ],
          },
        ]
      : []),
  ];

  const filterWhere: Prisma.PaymentWhereInput = {
    deletedAt: null,
    isReturn: false,
    AND: filterAnd,
  };

  const where: Prisma.PaymentWhereInput = {
    ...filterWhere,
    ...(pagination.where ? { AND: [...filterAnd, pagination.where] } : {}),
  };

  const [totalAgg, methodGroups, rowsRaw] = await Promise.all([
    db.payment.aggregate({
      where: filterWhere,
      _sum: { amount: true },
      _count: { _all: true },
    }),
    db.payment.groupBy({
      by: ['method'],
      where: filterWhere,
      _sum: { amount: true },
    }),
    db.payment.findMany({
      where,
      select: {
        id: true,
        amount: true,
        method: true,
        currency: true,
        paidOn: true,
        createdAt: true,
        paymentRefNo: true,
        saleId: true,
        sale: {
          select: {
            id: true,
            reference: true,
            locationCode: true,
            customer: {
              select: {
                id: true,
                name: true,
                phone: true,
                customerGroup: { select: { name: true } },
              },
            },
          },
        },
        account: { select: { name: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    }),
  ]);

  const page = paginateRows(rowsRaw, pageSize, 'createdAt', 'date');
  const currency = page.rows[0]?.currency ?? 'NGN';
  const total = toNumber(totalAgg._sum.amount ?? 0);

  const tableRows: ReportsTableRow[] = page.rows.map((row) => {
    const customer = row.sale?.customer;
    const paid = row.paidOn ?? row.createdAt;
    return {
      // Keep payment id unique for React keys; navigate via saleId when present.
      id: row.id,
      saleId: row.saleId ?? undefined,
      recordType: row.saleId ? 'sale' : 'payment',
      referenceNo: row.paymentRefNo ?? row.id.slice(0, 8),
      paidOn: paid.toISOString().replace('T', ' ').slice(0, 19),
      amount: Math.round(toNumber(row.amount) * 100) / 100,
      currency: row.currency,
      customer: customer?.name ?? 'WALK-IN',
      contactId: customer?.id?.slice(0, 10) ?? '—',
      customerGroup: customer?.customerGroup?.name ?? '—',
      paymentMethod: row.method ?? row.account?.name ?? '—',
      sell: row.sale?.reference ?? '—',
      actions: paymentActions(row.id, row.saleId),
    };
  });

  return {
    kpis: [
      currencyKpi('Collected', 'collected', total, currency, '#059669', 'wallet'),
      countKpi(
        'Payments',
        'paymentCount',
        totalAgg._count._all,
        '#2563eb',
        'banknote',
      ),
      countKpi('Methods', 'methods', methodGroups.length, '#9333ea', 'credit-card'),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'referenceNo', header: 'Reference No' },
        { key: 'paidOn', header: 'Paid on' },
        { key: 'amount', header: 'Amount' },
        { key: 'customer', header: 'Customer' },
        { key: 'contactId', header: 'Contact ID' },
        { key: 'customerGroup', header: 'Customer Group' },
        { key: 'paymentMethod', header: 'Payment Method' },
        { key: 'sell', header: 'Sell' },
      ],
      rows: tableRows,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      pageSize: page.pageSize,
      columnTotals: {
        amount: Math.round(total * 100) / 100,
      },
    },
  };
}

/** Product Sell Report — Detailed / By Category / By Brand. */
export async function buildProductSellReport(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  options?: ReportRunOptions,
): Promise<ReportsDashboard> {
  const view = options?.view ?? 'detailed';
  if (view === 'by-category' || view === 'by-brand') {
    return buildProductSellAggregated(db, tenantId, from, to, options, view);
  }
  return buildProductSellDetailed(db, tenantId, from, to, options);
}

async function buildProductSellFromJobs(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  options?: ReportRunOptions,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const pageSize = pageSizeOf(options);
  const pagination = buildCompositeCursorQuery({
    sortField: 'createdAt',
    sortDir: 'desc',
    cursor: options?.cursor,
    limit: pageSize + 1,
    sortValueType: 'date',
  });

  const jobFilter: Prisma.JobWhereInput = {
    tenantId,
    deletedAt: null,
    status: 'Delivered',
    updatedAt: { gte: window.from, lte: window.to },
    sales: { none: { deletedAt: null } },
    ...(options?.customerId ? { customerId: options.customerId } : {}),
    ...(options?.locationCode ? { locationCode: options.locationCode } : {}),
  };

  const filterWhere: Prisma.JobMaterialWhereInput = {
    job: jobFilter,
    ...(options?.search
      ? {
          OR: [
            { name: { contains: options.search, mode: 'insensitive' } },
            { supplierName: { contains: options.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const where: Prisma.JobMaterialWhereInput = {
    ...filterWhere,
    ...(pagination.where as Prisma.JobMaterialWhereInput | undefined),
  };

  const [lineCount, totalsAgg, rowsRaw] = await Promise.all([
    db.jobMaterial.count({ where: filterWhere }),
    db.jobMaterial.aggregate({
      where: filterWhere,
      _sum: { totalCost: true, quantity: true },
    }),
    db.jobMaterial.findMany({
      where,
      select: {
        id: true,
        name: true,
        quantity: true,
        unitCost: true,
        totalCost: true,
        itemId: true,
        supplierName: true,
        createdAt: true,
        job: {
          select: {
            id: true,
            reference: true,
            updatedAt: true,
            locationCode: true,
            customerName: true,
            customer: {
              select: { id: true, name: true, phone: true },
            },
          },
        },
        // purchaseMovementId / item for stock + purchase ref
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    }),
  ]);

  const page = paginateRows(rowsRaw, pageSize, 'createdAt', 'date');
  const itemIds = [
    ...new Set(
      page.rows.map((r) => r.itemId).filter((id): id is string => Boolean(id)),
    ),
  ];
  const items =
    itemIds.length > 0
      ? await db.item.findMany({
          where: { id: { in: itemIds } },
          select: {
            id: true,
            sku: true,
            carModel: true,
            category: true,
            quantity: true,
            brand: { select: { name: true } },
          },
        })
      : [];
  const itemById = new Map(items.map((i) => [i.id, i]));
  const currency = 'NGN';

  const tableRows: ReportsTableRow[] = page.rows.map((row) => {
    const item = row.itemId ? itemById.get(row.itemId) : undefined;
    const qty = toNumber(row.quantity);
    const unitPrice = toNumber(row.unitCost);
    const lineTotal = toNumber(row.totalCost);
    return {
      id: row.id,
      itemId: row.itemId ?? undefined,
      recordType: 'job',
      product: row.name,
      sku: item?.sku ?? '—',
      carModel: item?.carModel?.trim() ? item.carModel : '—',
      customerName:
        row.job.customer?.name ?? row.job.customerName ?? 'WALK-IN-CUSTOMER',
      customerId: row.job.customer?.id,
      contactId: row.job.customer?.id?.slice(0, 10) ?? '—',
      contactNumber: row.job.customer?.phone ?? '—',
      invoiceNo: row.job.reference,
      date: row.job.updatedAt.toISOString().replace('T', ' ').slice(0, 19),
      quantity: Math.round(qty * 100) / 100,
      unitPrice: Math.round(unitPrice * 100) / 100,
      discount: 0,
      tax: 0,
      priceIncTax: Math.round(unitPrice * 100) / 100,
      total: Math.round(lineTotal * 100) / 100,
      currency,
      paymentMethod: '—',
      location: row.job.locationCode ?? '—',
      purchaseRef: '—',
      supplierName: row.supplierName ?? '—',
      currentStock: item?.quantity ?? 0,
      category: item?.category?.trim() ? item.category : '—',
      brand: item?.brand?.name ?? '—',
      actions: [
        {
          kind: 'view-record' as const,
          label: 'View',
          payload: { recordType: 'job', id: row.job.id },
        },
      ],
    };
  });

  return {
    kpis: [
      countKpi('Lines', 'lines', lineCount, '#2563eb', 'list'),
      currencyKpi(
        'Revenue',
        'revenue',
        Math.round(toNumber(totalsAgg._sum.totalCost ?? 0)),
        currency,
        '#059669',
        'wallet',
      ),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'product', header: 'Product' },
        { key: 'sku', header: 'SKU' },
        { key: 'carModel', header: 'Car Model' },
        { key: 'customerName', header: 'Customer name' },
        { key: 'contactId', header: 'Contact ID' },
        { key: 'contactNumber', header: 'Contact Number' },
        { key: 'invoiceNo', header: 'Invoice No.' },
        { key: 'date', header: 'Date' },
        { key: 'quantity', header: 'Quantity' },
        { key: 'unitPrice', header: 'Unit Price' },
        { key: 'discount', header: 'Discount' },
        { key: 'tax', header: 'Tax' },
        { key: 'priceIncTax', header: 'Price inc. tax' },
        { key: 'total', header: 'Total' },
        { key: 'paymentMethod', header: 'Payment Method' },
        { key: 'location', header: 'Location' },
        { key: 'purchaseRef', header: 'Purchase ref no.' },
        { key: 'supplierName', header: 'Supplier Name' },
        { key: 'currentStock', header: 'Current stock' },
      ],
      rows: tableRows,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      pageSize: page.pageSize,
      columnTotals: {
        quantity: Math.round(toNumber(totalsAgg._sum.quantity ?? 0) * 100) / 100,
        discount: 0,
        total: Math.round(toNumber(totalsAgg._sum.totalCost ?? 0) * 100) / 100,
      },
    },
  };
}

async function buildProductSellDetailed(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  options?: ReportRunOptions,
  opts?: { skipLineCount?: boolean },
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const pageSize = pageSizeOf(options);
  const pagination = buildCompositeCursorQuery({
    sortField: 'createdAt',
    sortDir: 'desc',
    cursor: options?.cursor,
    limit: pageSize + 1,
    sortValueType: 'date',
  });

  const saleFilter: Prisma.SaleWhereInput = {
    tenantId,
    deletedAt: null,
    status: { not: 'draft' },
    date: { gte: window.from, lte: window.to },
    ...(options?.customerId ? { customerId: options.customerId } : {}),
    ...(options?.customerGroupId
      ? { customer: { customerGroupId: options.customerGroupId } }
      : {}),
    ...(options?.locationCode ? { locationCode: options.locationCode } : {}),
  };

  const itemFilter: Prisma.ItemWhereInput | undefined =
    options?.category || options?.brandId
      ? {
          ...(options.category ? { category: options.category } : {}),
          ...(options.brandId ? { brandId: options.brandId } : {}),
        }
      : undefined;

  let itemIdsFilter: string[] | undefined;
  if (itemFilter) {
    const matched = await db.item.findMany({
      where: { tenantId, deletedAt: null, ...itemFilter },
      select: { id: true },
      take: 1000,
    });
    itemIdsFilter = matched.map((i) => i.id);
  }

  const filterWhere: Prisma.SaleLineWhereInput = {
    sale: saleFilter,
    ...(itemIdsFilter
      ? { itemId: { in: itemIdsFilter.length > 0 ? itemIdsFilter : ['__none__'] } }
      : {}),
    ...(options?.search
      ? {
          OR: [
            { sku: { contains: options.search, mode: 'insensitive' } },
            { name: { contains: options.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  // VA / job-centric tenants often have materials on jobs without Sale lines.
  const saleLineCount = await db.saleLine.count({ where: filterWhere });
  if (saleLineCount === 0) {
    return buildProductSellFromJobs(db, tenantId, from, to, options);
  }

  const where: Prisma.SaleLineWhereInput = {
    ...filterWhere,
    ...(pagination.where as Prisma.SaleLineWhereInput | undefined),
  };

  const [lineCount, totalsAgg, rowsRaw] = await Promise.all([
    opts?.skipLineCount
      ? Promise.resolve(0)
      : db.saleLine.count({ where: filterWhere }),
    db.saleLine.aggregate({
      where: filterWhere,
      _sum: { lineTotal: true, discountAmount: true, quantity: true },
    }),
    db.saleLine.findMany({
      where,
      select: {
        id: true,
        sku: true,
        name: true,
        quantity: true,
        unitPrice: true,
        lineTotal: true,
        discountAmount: true,
        itemId: true,
        createdAt: true,
        sale: {
          select: {
            id: true,
            reference: true,
            date: true,
            paymentMethod: true,
            locationCode: true,
            taxAmount: true,
            discountAmount: true,
            total: true,
            customer: {
              select: {
                id: true,
                name: true,
                phone: true,
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    }),
  ]);

  const page = paginateRows(rowsRaw, pageSize, 'createdAt', 'date');
  const itemIds = [
    ...new Set(
      page.rows.map((r) => r.itemId).filter((id): id is string => Boolean(id)),
    ),
  ];
  const skus = [
    ...new Set(page.rows.map((r) => r.sku).filter((sku) => Boolean(sku))),
  ];
  const items =
    itemIds.length > 0
      ? await db.item.findMany({
          where: { id: { in: itemIds } },
          select: {
            id: true,
            carModel: true,
            category: true,
            quantity: true,
            brand: { select: { name: true } },
          },
        })
      : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  type InboundHit = {
    sku: string;
    reference: string;
    supplier_name: string | null;
  };
  const inbound =
    skus.length > 0
      ? await db.$queryRaw<InboundHit[]>`
          SELECT DISTINCT ON (COALESCE(elem->>'sku', ''))
            COALESCE(elem->>'sku', '') AS sku,
            sm.reference,
            sup.name AS supplier_name
          FROM "StockMovement" sm
          LEFT JOIN "Supplier" sup ON sup.id = sm."supplierId"
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(sm.lines::jsonb) = 'array' THEN sm.lines::jsonb
              ELSE '[]'::jsonb
            END
          ) AS elem
          WHERE sm."tenantId" = ${tenantId}
            AND sm."deletedAt" IS NULL
            AND sm.type::text = 'inbound'
            AND COALESCE(elem->>'sku', '') = ANY(${skus})
          ORDER BY COALESCE(elem->>'sku', ''), sm.date DESC
        `
      : [];
  const inboundBySku = new Map(inbound.map((r) => [r.sku, r]));
  const currency = 'NGN';

  const tableRows: ReportsTableRow[] = page.rows.map((row) => {
    const item = row.itemId ? itemById.get(row.itemId) : undefined;
    const hit = inboundBySku.get(row.sku);
    const qty = toNumber(row.quantity);
    const unitPrice = toNumber(row.unitPrice);
    const discount = toNumber(row.discountAmount ?? 0);
    const lineTotal = toNumber(row.lineTotal);
    // Per-line tax approximation from sale tax share
    const saleTotal = toNumber(row.sale.total) || 1;
    const taxShare =
      (toNumber(row.sale.taxAmount ?? 0) * lineTotal) / saleTotal;
    return {
      // Line id stays unique for table keys; saleId is used for navigation.
      id: row.id,
      saleId: row.sale.id,
      itemId: row.itemId ?? undefined,
      recordType: 'sale',
      product: row.name,
      sku: row.sku,
      carModel: item?.carModel?.trim() ? item.carModel : '—',
      customerName: row.sale.customer?.name ?? 'WALK-IN-CUSTOMER',
      customerId: row.sale.customer?.id,
      contactId: row.sale.customer?.id?.slice(0, 10) ?? '—',
      contactNumber: row.sale.customer?.phone ?? '—',
      invoiceNo: row.sale.reference,
      date: row.sale.date.toISOString().replace('T', ' ').slice(0, 19),
      quantity: Math.round(qty * 100) / 100,
      unitPrice: Math.round(unitPrice * 100) / 100,
      discount: Math.round(discount * 100) / 100,
      tax: Math.round(taxShare * 100) / 100,
      priceIncTax: Math.round((unitPrice + taxShare / (qty || 1)) * 100) / 100,
      total: Math.round(lineTotal * 100) / 100,
      currency,
      paymentMethod: row.sale.paymentMethod ?? '—',
      location: row.sale.locationCode ?? '—',
      purchaseRef: hit?.reference ?? '—',
      supplierName: hit?.supplier_name ?? '—',
      currentStock: item?.quantity ?? 0,
      category: item?.category?.trim() ? item.category : '—',
      brand: item?.brand?.name ?? '—',
      actions: saleLineActions(row.sale.id),
    };
  });

  return {
    kpis: [
      countKpi('Lines', 'lines', lineCount, '#2563eb', 'list'),
      currencyKpi(
        'Revenue',
        'revenue',
        Math.round(toNumber(totalsAgg._sum.lineTotal ?? 0)),
        currency,
        '#059669',
        'wallet',
      ),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'product', header: 'Product' },
        { key: 'sku', header: 'SKU' },
        { key: 'carModel', header: 'Car Model' },
        { key: 'customerName', header: 'Customer name' },
        { key: 'contactId', header: 'Contact ID' },
        { key: 'contactNumber', header: 'Contact Number' },
        { key: 'invoiceNo', header: 'Invoice No.' },
        { key: 'date', header: 'Date' },
        { key: 'quantity', header: 'Quantity' },
        { key: 'unitPrice', header: 'Unit Price' },
        { key: 'discount', header: 'Discount' },
        { key: 'tax', header: 'Tax' },
        { key: 'priceIncTax', header: 'Price inc. tax' },
        { key: 'total', header: 'Total' },
        { key: 'paymentMethod', header: 'Payment Method' },
        { key: 'location', header: 'Location' },
        { key: 'purchaseRef', header: 'Purchase ref no.' },
        { key: 'supplierName', header: 'Supplier Name' },
        { key: 'currentStock', header: 'Current stock' },
      ],
      rows: tableRows,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      pageSize: page.pageSize,
      columnTotals: {
        quantity: Math.round(toNumber(totalsAgg._sum.quantity ?? 0) * 100) / 100,
        discount:
          Math.round(toNumber(totalsAgg._sum.discountAmount ?? 0) * 100) / 100,
        total: Math.round(toNumber(totalsAgg._sum.lineTotal ?? 0) * 100) / 100,
      },
    },
  };
}

async function buildProductSellAggregated(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  options?: ReportRunOptions,
  view: 'by-category' | 'by-brand' = 'by-category',
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const pageSize = pageSizeOf(options);

  type AggRow = {
    group_key: string;
    units: Prisma.Decimal | null;
    revenue: Prisma.Decimal | null;
    lines: bigint;
  };

  const locationClause = options?.locationCode
    ? Prisma.sql`AND s."locationCode" = ${options.locationCode}`
    : Prisma.empty;
  const customerClause = options?.customerId
    ? Prisma.sql`AND s."customerId" = ${options.customerId}`
    : Prisma.empty;
  const searchClause = options?.search
    ? Prisma.sql`AND (sl.sku ILIKE ${'%' + options.search + '%'} OR sl.name ILIKE ${'%' + options.search + '%'})`
    : Prisma.empty;

  let offset = 0;
  if (options?.cursor) {
    try {
      const decoded = Buffer.from(options.cursor, 'base64url').toString('utf8');
      const parsed = Number.parseInt(decoded, 10);
      if (Number.isFinite(parsed) && parsed >= 0) offset = parsed;
    } catch {
      offset = 0;
    }
  }

  const baseFrom = Prisma.sql`
    FROM "SaleLine" sl
    INNER JOIN "Sale" s ON s.id = sl."saleId"
    LEFT JOIN "Item" i ON i.id = sl."itemId"
    ${
      view === 'by-brand'
        ? Prisma.sql`LEFT JOIN "Brand" b ON b.id = i."brandId"`
        : Prisma.empty
    }
    WHERE s."tenantId" = ${tenantId}
      AND s."deletedAt" IS NULL
      AND s.status::text <> 'draft'
      AND s.date >= ${window.from}
      AND s.date <= ${window.to}
      ${locationClause}
      ${customerClause}
      ${searchClause}
  `;

  const groupExpr =
    view === 'by-brand'
      ? Prisma.sql`COALESCE(b.name, 'Unbranded')`
      : Prisma.sql`COALESCE(NULLIF(TRIM(i.category), ''), 'Uncategorized')`;

  const [totalsRow, rows] = await Promise.all([
    db.$queryRaw<
      [
        {
          group_count: bigint;
          total_lines: bigint;
          total_revenue: Prisma.Decimal | null;
          total_units: Prisma.Decimal | null;
        },
      ]
    >`
      SELECT
        COUNT(*)::bigint AS group_count,
        COALESCE(SUM(lines), 0)::bigint AS total_lines,
        COALESCE(SUM(revenue), 0) AS total_revenue,
        COALESCE(SUM(units), 0) AS total_units
      FROM (
        SELECT
          ${groupExpr} AS group_key,
          COALESCE(SUM(sl.quantity), 0) AS units,
          COALESCE(SUM(sl."lineTotal"), 0) AS revenue,
          COUNT(*)::bigint AS lines
        ${baseFrom}
        GROUP BY 1
      ) agg
    `,
    db.$queryRaw<AggRow[]>`
      SELECT
        ${groupExpr} AS group_key,
        COALESCE(SUM(sl.quantity), 0) AS units,
        COALESCE(SUM(sl."lineTotal"), 0) AS revenue,
        COUNT(*)::bigint AS lines
      ${baseFrom}
      GROUP BY 1
      ORDER BY SUM(sl."lineTotal") DESC
      OFFSET ${offset}
      LIMIT ${pageSize + 1}
    `,
  ]);

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const labelKey = view === 'by-brand' ? 'brand' : 'category';
  const groupCount = Number(totalsRow[0]?.group_count ?? 0);
  const totalRevenue = toNumber(totalsRow[0]?.total_revenue ?? 0);

  return {
    kpis: [
      countKpi(
        view === 'by-brand' ? 'Brands' : 'Categories',
        'groups',
        groupCount,
        '#2563eb',
        'folder-tree',
      ),
      currencyKpi(
        'Revenue',
        'revenue',
        Math.round(totalRevenue),
        'NGN',
        '#059669',
        'wallet',
      ),
    ],
    charts: [],
    table: {
      columns: [
        {
          key: labelKey,
          header: view === 'by-brand' ? 'Brand' : 'Category',
        },
        { key: 'lines', header: 'Lines' },
        { key: 'units', header: 'Units' },
        { key: 'revenue', header: 'Revenue' },
      ],
      rows: page.map((row) => ({
        id: row.group_key,
        [labelKey]: row.group_key,
        lines: Number(row.lines),
        units: Math.round(toNumber(row.units ?? 0) * 100) / 100,
        revenue: Math.round(toNumber(row.revenue ?? 0)),
        currency: 'NGN',
      })),
      hasMore,
      nextCursor: hasMore
        ? Buffer.from(String(offset + pageSize)).toString('base64url')
        : null,
      pageSize,
      columnTotals: {
        lines: Number(totalsRow[0]?.total_lines ?? 0),
        units:
          Math.round(toNumber(totalsRow[0]?.total_units ?? 0) * 100) / 100,
        revenue: Math.round(totalRevenue),
      },
    },
  };
}

/** Product Purchase Report — inbound stock movement lines. */
export async function buildProductPurchaseReport(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  options?: ReportRunOptions,
): Promise<ReportsDashboard> {
  const window = resolveDateWindow(from, to);
  const pageSize = pageSizeOf(options);

  type PurchaseLineRow = {
    movement_id: string;
    date: Date;
    reference: string;
    location_code: string | null;
    supplier_name: string | null;
    sku: string;
    name: string;
    quantity: Prisma.Decimal | null;
    quantity_adjusted: Prisma.Decimal | null;
    unit_cost: Prisma.Decimal | null;
    description: string | null;
    ord: bigint;
  };

  // Cursor encodes date|id|ord
  let cursorDate: Date | null = null;
  let cursorId: string | null = null;
  let cursorOrd = 0;
  if (options?.cursor) {
    try {
      const parsed = JSON.parse(
        Buffer.from(options.cursor, 'base64url').toString('utf8'),
      ) as { date?: string; id?: string; ord?: number };
      if (parsed.date) cursorDate = new Date(parsed.date);
      cursorId = parsed.id ?? null;
      cursorOrd = parsed.ord ?? 0;
    } catch {
      /* ignore */
    }
  }

  const search = options?.search?.trim();

  const rows = await db.$queryRaw<PurchaseLineRow[]>`
    SELECT
      sm.id AS movement_id,
      sm.date,
      sm.reference,
      sm."locationCode" AS location_code,
      sup.name AS supplier_name,
      COALESCE(elem->>'sku', '—') AS sku,
      COALESCE(elem->>'name', elem->>'sku', '—') AS name,
      COALESCE((elem->>'quantity')::numeric, 0) AS quantity,
      COALESCE(
        (elem->>'quantityAdjusted')::numeric,
        (elem->>'adjustedQuantity')::numeric,
        (elem->>'quantity')::numeric,
        0
      ) AS quantity_adjusted,
      COALESCE(
        (elem->>'unitCost')::numeric,
        (elem->>'costPrice')::numeric,
        (elem->>'unitPrice')::numeric,
        0
      ) AS unit_cost,
      elem->>'description' AS description,
      ord::bigint AS ord
    FROM "StockMovement" sm
    LEFT JOIN "Supplier" sup ON sup.id = sm."supplierId"
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(sm.lines::jsonb) = 'array' THEN sm.lines::jsonb
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS t(elem, ord)
    WHERE sm."tenantId" = ${tenantId}
      AND sm."deletedAt" IS NULL
      AND sm.type::text = 'inbound'
      AND sm.date >= ${window.from}
      AND sm.date <= ${window.to}
      ${
        options?.supplierId
          ? Prisma.sql`AND sm."supplierId" = ${options.supplierId}`
          : Prisma.empty
      }
      ${
        options?.locationCode
          ? Prisma.sql`AND sm."locationCode" = ${options.locationCode}`
          : Prisma.empty
      }
      ${
        search
          ? Prisma.sql`AND (
              sm.reference ILIKE ${'%' + search + '%'}
              OR COALESCE(elem->>'sku','') ILIKE ${'%' + search + '%'}
              OR COALESCE(elem->>'name','') ILIKE ${'%' + search + '%'}
            )`
          : Prisma.empty
      }
      ${
        cursorDate && cursorId
          ? Prisma.sql`AND (
              sm.date < ${cursorDate}
              OR (sm.date = ${cursorDate} AND sm.id < ${cursorId})
              OR (sm.date = ${cursorDate} AND sm.id = ${cursorId} AND ord > ${cursorOrd})
            )`
          : Prisma.empty
      }
    ORDER BY sm.date DESC, sm.id DESC, ord ASC
    LIMIT ${pageSize + 1}
  `;

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({
            date: last.date.toISOString(),
            id: last.movement_id,
            ord: Number(last.ord),
          }),
        ).toString('base64url')
      : null;

  const [docCount, lineAgg] = await Promise.all([
    db.stockMovement.count({
      where: {
        tenantId,
        deletedAt: null,
        type: 'inbound',
        date: { gte: window.from, lte: window.to },
      },
    }),
    db.$queryRaw<Array<{ c: bigint; qty: Prisma.Decimal | null }>>`
      SELECT
        COUNT(*)::bigint AS c,
        COALESCE(SUM(
          COALESCE(
            (elem->>'quantity')::numeric,
            (elem->>'qty')::numeric,
            0
          )
        ), 0) AS qty
      FROM "StockMovement" sm
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(sm.lines::jsonb) = 'array' THEN sm.lines::jsonb
          ELSE '[]'::jsonb
        END
      ) AS elem
      WHERE sm."tenantId" = ${tenantId}
        AND sm."deletedAt" IS NULL
        AND sm.type::text = 'inbound'
        AND sm.date >= ${window.from}
        AND sm.date <= ${window.to}
    `,
  ]);

  return {
    kpis: [
      countKpi('Inbound Docs', 'inbound', docCount, '#059669', 'truck'),
      countKpi(
        'Line Items',
        'lines',
        Number(lineAgg[0]?.c ?? 0),
        '#2563eb',
        'package',
      ),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'product', header: 'Product' },
        { key: 'sku', header: 'SKU' },
        { key: 'supplier', header: 'Supplier' },
        { key: 'purchase', header: 'Reference No' },
        { key: 'purchaseDate', header: 'Date' },
        { key: 'quantity', header: 'Quantity' },
        { key: 'quantityAdjusted', header: 'Total Unit Adjusted' },
        { key: 'purchasePrice', header: 'Unit Purchase Price' },
        { key: 'subtotal', header: 'Subtotal' },
        { key: 'location', header: 'Location' },
        { key: 'description', header: 'Description' },
      ],
      rows: page.map((row) => {
        const qty = Math.round(toNumber(row.quantity ?? 0) * 100) / 100;
        const adjusted =
          Math.round(toNumber(row.quantity_adjusted ?? row.quantity ?? 0) * 100) /
          100;
        const unit = Math.round(toNumber(row.unit_cost ?? 0) * 100) / 100;
        return {
          id: `${row.movement_id}-${row.ord}`,
          recordType: 'stockMovement',
          product: row.name,
          sku: row.sku,
          description: row.description ?? '—',
          purchaseDate: row.date.toISOString().slice(0, 10),
          purchase: row.reference,
          supplier: row.supplier_name ?? '—',
          purchasePrice: unit,
          quantity: qty,
          quantityAdjusted: adjusted,
          subtotal: Math.round(qty * unit * 100) / 100,
          location: row.location_code ?? '—',
          currency: 'NGN',
        };
      }),
      hasMore,
      nextCursor,
      pageSize,
      columnTotals: {
        quantity: Math.round(toNumber(lineAgg[0]?.qty ?? 0) * 100) / 100,
        subtotal: Math.round(
          page.reduce(
            (sum, row) =>
              sum + toNumber(row.quantity ?? 0) * toNumber(row.unit_cost ?? 0),
            0,
          ) * 100,
        ) / 100,
      },
    },
  };
}

/** Items Report — sell lines with best-effort last inbound purchase by SKU. */
export async function buildItemsReport(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
  options?: ReportRunOptions,
): Promise<ReportsDashboard> {
  const pageSize = pageSizeOf(options);
  // Items report = sold lines + latest inbound purchase lookup per SKU.
  const sellReport = await buildProductSellDetailed(
    db,
    tenantId,
    from,
    to,
    options,
  );

  const skus = [
    ...new Set(
      (sellReport.table?.rows ?? [])
        .map((r) => String(r.sku ?? ''))
        .filter(Boolean),
    ),
  ];
  const itemIds = [
    ...new Set(
      (sellReport.table?.rows ?? [])
        .map((r) => (r.itemId != null ? String(r.itemId) : ''))
        .filter(Boolean),
    ),
  ];

  type InboundHit = {
    sku: string;
    date: Date;
    reference: string;
    supplier_id: string | null;
    supplier_name: string | null;
    unit_cost: Prisma.Decimal | null;
  };

  const [inbound, itemDescriptions] = await Promise.all([
    skus.length > 0
      ? db.$queryRaw<InboundHit[]>`
          SELECT DISTINCT ON (COALESCE(elem->>'sku', ''))
            COALESCE(elem->>'sku', '') AS sku,
            sm.date,
            sm.reference,
            sm."supplierId" AS supplier_id,
            sup.name AS supplier_name,
            COALESCE(
              (elem->>'unitCost')::numeric,
              (elem->>'costPrice')::numeric,
              (elem->>'unitPrice')::numeric,
              0
            ) AS unit_cost
          FROM "StockMovement" sm
          LEFT JOIN "Supplier" sup ON sup.id = sm."supplierId"
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(sm.lines::jsonb) = 'array' THEN sm.lines::jsonb
              ELSE '[]'::jsonb
            END
          ) AS elem
          WHERE sm."tenantId" = ${tenantId}
            AND sm."deletedAt" IS NULL
            AND sm.type::text = 'inbound'
            AND COALESCE(elem->>'sku', '') = ANY(${skus})
          ORDER BY COALESCE(elem->>'sku', ''), sm.date DESC
        `
      : Promise.resolve([] as InboundHit[]),
    itemIds.length > 0
      ? db.item.findMany({
          where: { id: { in: itemIds }, deletedAt: null },
          select: { id: true, description: true },
        })
      : Promise.resolve([] as Array<{ id: string; description: string | null }>),
  ]);

  const inboundBySku = new Map(inbound.map((r) => [r.sku, r]));
  const descriptionByItemId = new Map(
    itemDescriptions.map((i) => [i.id, i.description?.trim() || '']),
  );

  const supplierFilter = options?.supplierId?.trim() || '';

  const mappedRows: ReportsTableRow[] = (sellReport.table?.rows ?? []).map((row) => {
    const sku = String(row.sku ?? '');
    const hit = inboundBySku.get(sku);
    const sellQty = Number(row.quantity ?? 0);
    const sellPrice = Number(row.unitPrice ?? 0);
    const itemId = row.itemId != null ? String(row.itemId) : '';
    const saleId = row.saleId != null ? String(row.saleId) : '';
    const customerId = row.customerId != null ? String(row.customerId) : '';
    const description =
      (itemId ? descriptionByItemId.get(itemId) : '') ||
      String(row.product ?? '').trim() ||
      '—';
    // Prefer product modal when we have a catalog item; otherwise sale.
    const recordType = itemId ? 'item' : saleId ? 'sale' : String(row.recordType ?? '');
    const actions: ReportRowAction[] = [];
    if (itemId) {
      actions.push({
        kind: 'view-record',
        label: 'View product',
        payload: { recordType: 'item', itemId, id: itemId },
      });
    }
    if (saleId) {
      actions.push({
        kind: 'view-record',
        label: 'View sale',
        payload: { recordType: 'sale', saleId, id: saleId },
      });
    }
    if (customerId) {
      actions.push({
        kind: 'view-record',
        label: 'View customer',
        payload: { recordType: 'customer', customerId, id: customerId },
      });
    }
    return {
      id: String(row.id),
      saleId: saleId || undefined,
      itemId: itemId || undefined,
      customerId: customerId || undefined,
      recordType,
      product: row.product ?? '—',
      sku,
      description,
      purchaseDate: hit ? hit.date.toISOString().slice(0, 10) : '—',
      purchase: hit?.reference ?? '—',
      supplier: hit?.supplier_name ?? String(row.supplierName ?? '—'),
      supplierId: hit?.supplier_id ?? undefined,
      purchasePrice: hit
        ? Math.round(toNumber(hit.unit_cost ?? 0) * 100) / 100
        : '—',
      sellDate: String(row.date ?? '—').slice(0, 10),
      sale: row.invoiceNo ?? '—',
      customer: row.customerName ?? '—',
      location: row.location ?? '—',
      sellQuantity: sellQty,
      sellingPrice: sellPrice,
      subtotal:
        row.total != null
          ? Math.round(Number(row.total) * 100) / 100
          : Math.round(sellQty * sellPrice * 100) / 100,
      currency: 'NGN',
      actions: actions.length > 0 ? actions : undefined,
    };
  });

  const rows = supplierFilter
    ? mappedRows.filter((row) => String(row.supplierId ?? '') === supplierFilter)
    : mappedRows;

  const totalLines = supplierFilter
    ? rows.length
    : Number(
        sellReport.kpis?.find((k) => k.metricKey === 'lines')?.value ??
          rows.length,
      );
  const uniqueProducts = new Set(
    rows
      .map((r) => (r.itemId != null ? String(r.itemId) : String(r.sku ?? '')))
      .filter(Boolean),
  ).size;
  const totalRevenue = supplierFilter
    ? rows.reduce((sum, row) => sum + Number(row.subtotal ?? 0), 0)
    : Number(
        sellReport.kpis?.find((k) => k.metricKey === 'revenue')?.value ??
          rows.reduce((sum, row) => sum + Number(row.subtotal ?? 0), 0),
      );

  return {
    kpis: [
      countKpi('Products', 'products', uniqueProducts, '#9333ea', 'package'),
      countKpi('Sold lines', 'items', totalLines, '#2563eb', 'list'),
      currencyKpi(
        'Subtotal',
        'revenue',
        Math.round(totalRevenue),
        'NGN',
        '#059669',
        'wallet',
      ),
    ],
    charts: [],
    table: {
      columns: [
        { key: 'product', header: 'Product' },
        { key: 'sku', header: 'SKU' },
        { key: 'description', header: 'Description' },
        { key: 'purchaseDate', header: 'Purchase Date' },
        { key: 'purchase', header: 'Purchase' },
        { key: 'supplier', header: 'Supplier' },
        { key: 'purchasePrice', header: 'Purchase Price' },
        { key: 'sellDate', header: 'Sell Date' },
        { key: 'sale', header: 'Sale' },
        { key: 'customer', header: 'Customer' },
        { key: 'location', header: 'Location' },
        { key: 'sellQuantity', header: 'Sell Quantity' },
        { key: 'sellingPrice', header: 'Selling Price' },
        { key: 'subtotal', header: 'Subtotal' },
      ],
      rows,
      hasMore: supplierFilter ? false : sellReport.table?.hasMore,
      nextCursor: supplierFilter ? null : sellReport.table?.nextCursor,
      pageSize: sellReport.table?.pageSize ?? pageSize,
      columnTotals: {
        ...(sellReport.table?.columnTotals?.quantity != null && !supplierFilter
          ? { sellQuantity: sellReport.table.columnTotals.quantity }
          : {}),
        ...(sellReport.table?.columnTotals?.total != null && !supplierFilter
          ? { subtotal: sellReport.table.columnTotals.total }
          : {}),
      },
    },
  };
}
