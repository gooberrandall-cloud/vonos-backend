import type { OverviewPanel } from '@vonos/types';
import type { TenantScopedPrisma } from '../../common/prisma/prisma.service';
import { parseMovementLines, toNumber } from '../../common/utils/serializers';

const PANEL_LIMIT = 10;

export async function buildStockAlertPanel(
  db: TenantScopedPrisma,
  tenantId: string,
): Promise<OverviewPanel> {
  const items = await db.item.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: { in: ['low_stock', 'out_of_stock'] },
    },
    orderBy: { quantity: 'asc' },
    take: PANEL_LIMIT,
    select: {
      id: true,
      sku: true,
      name: true,
      quantity: true,
      reorderPoint: true,
      locationCode: true,
      status: true,
    },
  });

  return {
    id: 'stock-alert',
    title: 'Product Stock Alert',
    viewAllRoute: 'inventory',
    columns: [
      { key: 'product', header: 'Product' },
      { key: 'sku', header: 'SKU' },
      { key: 'location', header: 'Location' },
      { key: 'qty', header: 'Qty' },
      { key: 'alert', header: 'Alert' },
    ],
    rows: items.map((item) => ({
      id: item.id,
      product: item.name,
      sku: item.sku,
      location: item.locationCode ?? '—',
      qty: item.quantity,
      alert: item.status === 'out_of_stock' ? 'Out of stock' : 'Low stock',
    })),
  };
}

export async function buildPurchasePaymentDuesPanel(
  db: TenantScopedPrisma,
  tenantId: string,
): Promise<OverviewPanel> {
  const movements = await db.stockMovement.findMany({
    where: {
      tenantId,
      deletedAt: null,
      type: 'inbound',
      status: { in: ['Pending', 'Approved', 'Received'] },
    },
    include: { supplier: { select: { name: true } } },
    orderBy: { date: 'desc' },
    take: PANEL_LIMIT,
  });

  return {
    id: 'purchase-payment-dues',
    title: 'Purchase Payment Due',
    viewAllRoute: 'inbound',
    columns: [
      { key: 'ref', header: 'Reference' },
      { key: 'supplier', header: 'Supplier' },
      { key: 'date', header: 'Date' },
      { key: 'amount', header: 'Amount Due' },
      { key: 'status', header: 'Status' },
    ],
    rows: movements.map((row) => {
      const lines = parseMovementLines(row.lines);
      const grandTotal = lines.reduce(
        (sum, line) =>
          sum + (line.quantity ?? 0) * toNumber((line as { unitCost?: number }).unitCost ?? 0),
        0,
      );
      return {
        id: row.id,
        ref: row.reference,
        supplier: row.supplier?.name ?? '—',
        date: row.date.toISOString().slice(0, 10),
        amount: grandTotal,
        status: row.status,
      };
    }),
  };
}

export async function buildSalesPaymentDuesPanel(
  db: TenantScopedPrisma,
  tenantId: string,
): Promise<OverviewPanel> {
  const sales = await db.sale.findMany({
    where: {
      tenantId,
      deletedAt: null,
      paymentStatus: { in: ['due', 'partial'] },
    },
    select: {
      id: true,
      reference: true,
      date: true,
      total: true,
      paymentStatus: true,
      customer: { select: { name: true } },
      payments: { where: { deletedAt: null }, select: { amount: true } },
    },
    orderBy: { date: 'desc' },
    take: PANEL_LIMIT,
  });

  return {
    id: 'sales-payment-dues',
    title: 'Sales Payment Due',
    viewAllRoute: 'sales',
    columns: [
      { key: 'ref', header: 'Invoice No.' },
      { key: 'customer', header: 'Customer' },
      { key: 'date', header: 'Date' },
      { key: 'amount', header: 'Amount Due' },
      { key: 'status', header: 'Payment Status' },
    ],
    rows: sales.map((sale) => {
      const paid = sale.payments.reduce(
        (sum, p) => sum + toNumber(p.amount),
        0,
      );
      const total = toNumber(sale.total);
      const due = Math.max(0, total - paid);
      return {
        id: sale.id,
        ref: sale.reference,
        customer: sale.customer?.name ?? 'Walk-in',
        date: sale.date.toISOString().slice(0, 10),
        amount: due,
        status: sale.paymentStatus ?? 'due',
      };
    }),
  };
}

export async function buildOverviewPanels(
  db: TenantScopedPrisma,
  tenantId: string,
): Promise<OverviewPanel[]> {
  const stockAlert = await buildStockAlertPanel(db, tenantId);
  const purchaseDues = await buildPurchasePaymentDuesPanel(db, tenantId);
  const salesDues = await buildSalesPaymentDuesPanel(db, tenantId);
  return [stockAlert, purchaseDues, salesDues];
}
