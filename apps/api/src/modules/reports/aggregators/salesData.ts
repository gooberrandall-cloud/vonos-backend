import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { toNumber } from '../../../common/utils/serializers';
import {
  inWindow,
  priorWindow,
  resolveDateWindow,
  type DateWindow,
} from './date-utils';
import type { SaleLineRow } from './productSales';

/** Safety cap for row-level sale graphs (all-time detail is truncated). */
export const SALE_REPORT_ROW_CAP = 2_000;

export interface NormalizedSale {
  id: string;
  reference: string;
  date: Date;
  total: number;
  status: string;
  paymentStatus: string | null;
  currency: string;
  customerName: string;
  locationCode: string | null;
  staffName: string | null;
  lines: SaleLineRow[];
}

export interface SalesReportContext {
  window: DateWindow;
  prior: DateWindow;
  periodSales: NormalizedSale[];
  priorSales: NormalizedSale[];
  currency: string;
}

function normalizeSale(sale: {
  id: string;
  reference: string;
  date: Date;
  total: Parameters<typeof toNumber>[0];
  status: string;
  paymentStatus: string | null;
  currency: string;
  locationCode: string | null;
  cleanerName: string | null;
  serviceStaffEmployee?: { name: string } | null;
  customer: { name: string } | null;
  lines: SaleLineRow[];
}): NormalizedSale {
  return {
    id: sale.id,
    reference: sale.reference,
    date: sale.date,
    total: toNumber(sale.total),
    status: sale.status,
    paymentStatus: sale.paymentStatus,
    currency: sale.currency,
    customerName: sale.customer?.name ?? 'Walk-in',
    locationCode: sale.locationCode,
    staffName:
      sale.cleanerName?.trim() ||
      sale.serviceStaffEmployee?.name?.trim() ||
      null,
    lines: sale.lines,
  };
}

export async function loadSalesReportContext(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<SalesReportContext> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);

  const sales = await db.sale.findMany({
    where: {
      deletedAt: null,
      status: { not: 'draft' },
      date: { gte: prior.from, lte: window.to },
    },
    select: {
      id: true,
      reference: true,
      total: true,
      currency: true,
      status: true,
      paymentStatus: true,
      date: true,
      locationCode: true,
      cleanerName: true,
      serviceStaffEmployee: { select: { name: true } },
      customer: { select: { name: true } },
    },
    orderBy: { date: 'desc' },
    take: SALE_REPORT_ROW_CAP,
  });

  if (sales.length === 0) {
    return {
      window,
      prior,
      periodSales: [],
      priorSales: [],
      currency: 'NGN',
    };
  }

  const saleIds = sales.map((sale) => sale.id);
  const lines = await db.saleLine.findMany({
    where: { saleId: { in: saleIds } },
    select: {
      saleId: true,
      name: true,
      sku: true,
      lineTotal: true,
      quantity: true,
      itemId: true,
    },
  });

  const linesBySale = new Map<string, SaleLineRow[]>();
  for (const line of lines) {
    const bucket = linesBySale.get(line.saleId) ?? [];
    bucket.push(line);
    linesBySale.set(line.saleId, bucket);
  }

  const normalized: NormalizedSale[] = sales.map((sale) =>
    normalizeSale({
      ...sale,
      lines: linesBySale.get(sale.id) ?? [],
    }),
  );
  const periodSales = normalized.filter((sale) => inWindow(sale.date, window));
  const priorSales = normalized.filter((sale) => inWindow(sale.date, prior));

  return {
    window,
    prior,
    periodSales,
    priorSales,
    currency: normalized[0]?.currency ?? 'NGN',
  };
}

/** Period window only — skips prior-period sales fetch (used by P&L legacy path). */
export async function loadPeriodSalesOnly(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<Pick<SalesReportContext, 'window' | 'periodSales' | 'currency'>> {
  const window = resolveDateWindow(from, to);

  // Header rows first (no nested lines) — much cheaper over Neon.
  const sales = await db.sale.findMany({
    where: {
      deletedAt: null,
      status: { not: 'draft' },
      date: { gte: window.from, lte: window.to },
    },
    select: {
      id: true,
      reference: true,
      total: true,
      currency: true,
      status: true,
      paymentStatus: true,
      date: true,
      locationCode: true,
      cleanerName: true,
      serviceStaffEmployee: { select: { name: true } },
      customer: { select: { name: true } },
    },
    orderBy: { date: 'desc' },
    take: SALE_REPORT_ROW_CAP,
  });

  if (sales.length === 0) {
    return { window, periodSales: [], currency: 'NGN' };
  }

  const saleIds = sales.map((sale) => sale.id);
  const lines = await db.saleLine.findMany({
    where: { saleId: { in: saleIds } },
    select: {
      saleId: true,
      name: true,
      sku: true,
      lineTotal: true,
      quantity: true,
      itemId: true,
    },
  });

  const linesBySale = new Map<string, SaleLineRow[]>();
  for (const line of lines) {
    const bucket = linesBySale.get(line.saleId) ?? [];
    bucket.push(line);
    linesBySale.set(line.saleId, bucket);
  }

  const periodSales: NormalizedSale[] = sales.map((sale) =>
    normalizeSale({
      ...sale,
      lines: linesBySale.get(sale.id) ?? [],
    }),
  );

  return {
    window,
    periodSales,
    currency: periodSales[0]?.currency ?? 'NGN',
  };
}
