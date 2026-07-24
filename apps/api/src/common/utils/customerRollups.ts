import type { Prisma } from '@prisma/client';
import type { TenantScopedPrisma } from '../prisma/prisma.service';
import { toNumber } from './serializers';

type SaleRollupRow = {
  total: Prisma.Decimal;
  status: string;
  paymentStatus: string | null;
  payments: { amount: Prisma.Decimal }[];
};

export type CustomerFinancialRollupTotals = {
  totalSell: number;
  totalSellDue: number;
  totalSellPaid: number;
  totalSellReturn: number;
  totalAdvance: number;
  visitCount: number;
};

function saleTotalsFromRows(sales: SaleRollupRow[]): CustomerFinancialRollupTotals {
  let totalSell = 0;
  let totalSellDue = 0;
  let totalSellPaid = 0;
  let totalSellReturn = 0;

  for (const sale of sales) {
    const total = toNumber(sale.total);
    const paid = sale.payments.reduce(
      (sum, payment) => sum + toNumber(payment.amount),
      0,
    );
    const isReturn =
      sale.status === 'refunded' ||
      sale.status === 'partially_refunded' ||
      sale.status === 'written_off';

    if (isReturn) {
      totalSellReturn += total;
      continue;
    }

    totalSell += total;
    const effectivePaid =
      paid > 0 ? paid : sale.paymentStatus === 'paid' ? total : 0;
    totalSellPaid += effectivePaid;
    if (
      sale.paymentStatus === 'due' ||
      sale.paymentStatus === 'partial' ||
      sale.paymentStatus == null
    ) {
      totalSellDue += Math.max(0, total - effectivePaid);
    }
  }

  const totalAdvance = Math.max(0, totalSellPaid - totalSell);
  const visitCount = sales.filter(
    (sale) =>
      sale.status !== 'refunded' &&
      sale.status !== 'partially_refunded' &&
      sale.status !== 'written_off',
  ).length;

  return {
    totalSell,
    totalSellDue,
    totalSellPaid,
    totalSellReturn,
    totalAdvance,
    visitCount,
  };
}

/** Live financial rollups for a page of customers. */
export async function computeCustomerFinancialRollupsForIds(
  db: TenantScopedPrisma,
  customerIds: string[],
): Promise<Map<string, CustomerFinancialRollupTotals>> {
  const out = new Map<string, CustomerFinancialRollupTotals>();
  for (const id of customerIds) {
    out.set(id, {
      totalSell: 0,
      totalSellDue: 0,
      totalSellPaid: 0,
      totalSellReturn: 0,
      totalAdvance: 0,
      visitCount: 0,
    });
  }
  if (customerIds.length === 0) return out;

  const sales = await db.sale.findMany({
    where: { customerId: { in: customerIds }, deletedAt: null },
    select: {
      customerId: true,
      total: true,
      status: true,
      paymentStatus: true,
      payments: {
        where: { deletedAt: null },
        select: { amount: true },
      },
    },
  });

  const byCustomer = new Map<string, SaleRollupRow[]>();
  for (const sale of sales) {
    if (!sale.customerId) continue;
    const list = byCustomer.get(sale.customerId) ?? [];
    list.push(sale);
    byCustomer.set(sale.customerId, list);
  }

  for (const [customerId, rows] of byCustomer) {
    out.set(customerId, saleTotalsFromRows(rows));
  }
  return out;
}

/** Recompute denormalized customer financial rollups from sales history. */
export async function refreshCustomerFinancialRollups(
  db: TenantScopedPrisma,
  customerId: string,
): Promise<CustomerFinancialRollupTotals> {
  const sales = await db.sale.findMany({
    where: { customerId, deletedAt: null },
    select: {
      total: true,
      status: true,
      paymentStatus: true,
      payments: {
        where: { deletedAt: null },
        select: { amount: true },
      },
    },
  });

  const totals = saleTotalsFromRows(sales);
  await db.customer.update({
    where: { id: customerId },
    data: totals,
  });
  return totals;
}
