import type { StockStatus } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { toNumber } from '../../../common/utils/serializers';
import { priorWindow, resolveDateWindow, type DateWindow } from './date-utils';

export interface StockItemRow {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  quantity: number;
  reorderPoint: number | null;
  costPrice: number;
  status: string;
  currency: string;
}

export interface StockMovementRow {
  date: Date;
  type: string;
}

export interface StockReportContext {
  window: DateWindow;
  prior: DateWindow;
  todayWindow: DateWindow;
  items: StockItemRow[];
  periodMovements: StockMovementRow[];
  stockValue: number;
  totalSku: number;
  totalUnits: number;
  lowStockCount: number;
  outOfStockCount: number;
  todayInbound: number;
  todayOutbound: number;
  movementCount: number;
  priorMovementCount: number;
  velocity: number;
  priorVelocity: number;
  currency: string;
}

const lowStockStatuses: StockStatus[] = ['low_stock', 'out_of_stock'];

export async function loadStockReportContext(
  db: TenantScopedPrisma,
  from?: string,
  to?: string,
): Promise<StockReportContext> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  const todayWindow: DateWindow = { from: todayStart, to: todayEnd };

  const itemWhere = { deletedAt: null };

  const [
    rawItems,
    totalSku,
    quantitySum,
    lowStockCount,
    outOfStockCount,
    currencyRow,
    periodMovements,
    todayInbound,
    todayOutbound,
    movementCount,
    priorMovementCount,
  ] = await Promise.all([
    db.item.findMany({
      where: itemWhere,
      select: {
        id: true,
        sku: true,
        name: true,
        category: true,
        quantity: true,
        reorderPoint: true,
        costPrice: true,
        status: true,
        currency: true,
      },
    }),
    db.item.count({ where: itemWhere }),
    db.item.aggregate({
      where: itemWhere,
      _sum: { quantity: true },
    }),
    db.item.count({
      where: { ...itemWhere, status: { in: lowStockStatuses } },
    }),
    db.item.count({
      where: { ...itemWhere, status: 'out_of_stock' },
    }),
    db.item.findFirst({
      where: itemWhere,
      select: { currency: true },
      orderBy: { id: 'asc' },
    }),
    db.stockMovement.findMany({
      where: {
        deletedAt: null,
        date: { gte: window.from, lte: window.to },
      },
      select: { type: true, date: true },
    }),
    db.stockMovement.count({
      where: {
        deletedAt: null,
        type: 'inbound',
        date: { gte: todayStart, lte: todayEnd },
      },
    }),
    db.stockMovement.count({
      where: {
        deletedAt: null,
        type: 'outbound',
        date: { gte: todayStart, lte: todayEnd },
      },
    }),
    db.stockMovement.count({
      where: {
        deletedAt: null,
        date: { gte: window.from, lte: window.to },
      },
    }),
    db.stockMovement.count({
      where: {
        deletedAt: null,
        date: { gte: prior.from, lte: prior.to },
      },
    }),
  ]);

  const items: StockItemRow[] = rawItems.map((item) => ({
    id: item.id,
    sku: item.sku,
    name: item.name,
    category: item.category,
    quantity: item.quantity,
    reorderPoint: item.reorderPoint,
    costPrice: toNumber(item.costPrice),
    status: item.status,
    currency: item.currency,
  }));

  const stockValue = items.reduce(
    (sum, item) => sum + item.quantity * item.costPrice,
    0,
  );
  const totalUnits = quantitySum._sum.quantity ?? 0;
  const currency = currencyRow?.currency ?? items[0]?.currency ?? 'NGN';
  const velocity =
    totalSku > 0 ? Number((movementCount / totalSku).toFixed(2)) : 0;
  const priorVelocity =
    totalSku > 0 ? Number((priorMovementCount / totalSku).toFixed(2)) : 0;

  return {
    window,
    prior,
    todayWindow,
    items,
    periodMovements,
    stockValue,
    totalSku,
    totalUnits,
    lowStockCount,
    outOfStockCount,
    todayInbound,
    todayOutbound,
    movementCount,
    priorMovementCount,
    velocity,
    priorVelocity,
    currency,
  };
}
