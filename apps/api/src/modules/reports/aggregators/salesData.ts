import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { toNumber } from '../../../common/utils/serializers';
import {
  inWindow,
  priorWindow,
  resolveDateWindow,
  type DateWindow,
} from './date-utils';
import type { SaleLineRow } from './productSales';

const SALE_SELECT = {
  id: true,
  total: true,
  currency: true,
  status: true,
  paymentStatus: true,
  date: true,
  lines: {
    select: {
      name: true,
      sku: true,
      lineTotal: true,
      quantity: true,
      itemId: true,
    },
  },
} as const;

export interface NormalizedSale {
  id: string;
  date: Date;
  total: number;
  status: string;
  paymentStatus: string | null;
  currency: string;
  lines: SaleLineRow[];
}

export interface SalesReportContext {
  window: DateWindow;
  prior: DateWindow;
  periodSales: NormalizedSale[];
  priorSales: NormalizedSale[];
  currency: string;
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
    select: SALE_SELECT,
  });

  const normalized: NormalizedSale[] = sales.map((sale) => ({
    id: sale.id,
    date: sale.date,
    total: toNumber(sale.total),
    status: sale.status,
    paymentStatus: sale.paymentStatus,
    currency: sale.currency,
    lines: sale.lines,
  }));

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
