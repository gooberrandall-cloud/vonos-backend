import type { TenantScopedPrisma } from '../prisma/prisma.service';
import { parseMovementLines, toNumber } from './serializers';

const ACTIVE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export type SupplierPurchaseRollupTotals = {
  totalPurchase: number;
  totalPurchaseDue: number;
  totalPurchasePaid: number;
  totalPurchaseReturn: number;
  totalAdvance: number;
  lastPurchaseAt: Date | null;
};

function movementLineTotal(lines: ReturnType<typeof parseMovementLines>): number {
  return lines.reduce(
    (sum, line) =>
      sum + line.quantity * toNumber((line as { unitCost?: number }).unitCost ?? 0),
    0,
  );
}

/** Live rollups for a page of suppliers (line totals preferred; ledger as fallback). */
export async function computeSupplierPurchaseRollupsForIds(
  db: TenantScopedPrisma,
  supplierIds: string[],
): Promise<Map<string, SupplierPurchaseRollupTotals>> {
  const out = new Map<string, SupplierPurchaseRollupTotals>();
  for (const id of supplierIds) {
    out.set(id, {
      totalPurchase: 0,
      totalPurchaseDue: 0,
      totalPurchasePaid: 0,
      totalPurchaseReturn: 0,
      totalAdvance: 0,
      lastPurchaseAt: null,
    });
  }
  if (supplierIds.length === 0) return out;

  const movements = await db.stockMovement.findMany({
    where: { supplierId: { in: supplierIds }, deletedAt: null },
    select: {
      id: true,
      supplierId: true,
      lines: true,
      status: true,
      type: true,
      source: true,
      paymentStatus: true,
      date: true,
    },
  });

  const ledgerRows =
    movements.length === 0
      ? []
      : await db.ledgerEntry.findMany({
          where: {
            deletedAt: null,
            linkedRecordType: 'stock_movement',
            linkedRecordId: { in: movements.map((m) => m.id) },
          },
          select: { linkedRecordId: true, amount: true },
        });
  const ledgerByMovement = new Map<string, number>();
  for (const entry of ledgerRows) {
    if (!entry.linkedRecordId) continue;
    ledgerByMovement.set(
      entry.linkedRecordId,
      (ledgerByMovement.get(entry.linkedRecordId) ?? 0) + toNumber(entry.amount),
    );
  }

  for (const movement of movements) {
    if (!movement.supplierId) continue;
    const current = out.get(movement.supplierId);
    if (!current) continue;

    const lineTotal = movementLineTotal(parseMovementLines(movement.lines));
    const amount =
      lineTotal > 0 ? lineTotal : (ledgerByMovement.get(movement.id) ?? 0);

    if (movement.source === 'purchase_return') {
      current.totalPurchaseReturn += amount;
      continue;
    }
    if (movement.type !== 'inbound') continue;

    current.totalPurchase += amount;
    if (
      movement.paymentStatus === 'due' ||
      movement.paymentStatus === 'partial' ||
      movement.paymentStatus == null
    ) {
      current.totalPurchaseDue += amount;
    } else if (movement.paymentStatus === 'paid') {
      current.totalPurchasePaid += amount;
    } else {
      current.totalPurchaseDue += amount;
    }

    const received =
      movement.status === 'Received' || movement.status === 'Delivered';
    if (
      received &&
      (!current.lastPurchaseAt || movement.date > current.lastPurchaseAt)
    ) {
      current.lastPurchaseAt = movement.date;
    }
  }

  for (const [id, totals] of out) {
    out.set(id, {
      ...totals,
      totalAdvance: Math.max(0, totals.totalPurchasePaid - totals.totalPurchase),
    });
  }
  return out;
}

/** Recompute denormalized supplier purchase rollups from stock movements. */
export async function refreshSupplierPurchaseRollups(
  db: TenantScopedPrisma,
  supplierId: string,
): Promise<SupplierPurchaseRollupTotals> {
  const movements = await db.stockMovement.findMany({
    where: { supplierId, deletedAt: null },
    select: {
      id: true,
      lines: true,
      status: true,
      type: true,
      source: true,
      paymentStatus: true,
      date: true,
    },
  });

  const ledgerRows =
    movements.length === 0
      ? []
      : await db.ledgerEntry.findMany({
          where: {
            deletedAt: null,
            linkedRecordType: 'stock_movement',
            linkedRecordId: { in: movements.map((m) => m.id) },
          },
          select: { linkedRecordId: true, amount: true },
        });
  const ledgerByMovement = new Map<string, number>();
  for (const entry of ledgerRows) {
    if (!entry.linkedRecordId) continue;
    ledgerByMovement.set(
      entry.linkedRecordId,
      (ledgerByMovement.get(entry.linkedRecordId) ?? 0) + toNumber(entry.amount),
    );
  }

  let totalPurchase = 0;
  let totalPurchaseDue = 0;
  let totalPurchasePaid = 0;
  let totalPurchaseReturn = 0;
  let lastPurchaseAt: Date | null = null;

  for (const movement of movements) {
    const lineTotal = movementLineTotal(parseMovementLines(movement.lines));
    const amount = lineTotal > 0 ? lineTotal : (ledgerByMovement.get(movement.id) ?? 0);
    if (movement.source === 'purchase_return') {
      totalPurchaseReturn += amount;
      continue;
    }
    if (movement.type !== 'inbound') continue;

    totalPurchase += amount;
    if (
      movement.paymentStatus === 'due' ||
      movement.paymentStatus === 'partial' ||
      movement.paymentStatus == null
    ) {
      totalPurchaseDue += amount;
    } else if (movement.paymentStatus === 'paid') {
      totalPurchasePaid += amount;
    } else {
      totalPurchaseDue += amount;
    }

    const received =
      movement.status === 'Received' || movement.status === 'Delivered';
    if (received && (!lastPurchaseAt || movement.date > lastPurchaseAt)) {
      lastPurchaseAt = movement.date;
    }
  }

  const totals: SupplierPurchaseRollupTotals = {
    totalPurchase,
    totalPurchaseDue,
    totalPurchasePaid,
    totalPurchaseReturn,
    totalAdvance: Math.max(0, totalPurchasePaid - totalPurchase),
    lastPurchaseAt,
  };

  await db.supplier.update({
    where: { id: supplierId },
    data: {
      totalPurchase: totals.totalPurchase,
      totalPurchaseDue: totals.totalPurchaseDue,
      totalPurchasePaid: totals.totalPurchasePaid,
      totalPurchaseReturn: totals.totalPurchaseReturn,
      totalAdvance: totals.totalAdvance,
      lastPurchaseAt: totals.lastPurchaseAt,
    },
  });

  return totals;
}

export function supplierActivityStatus(
  lastPurchaseAt: Date | null | undefined,
  now = Date.now(),
): 'active' | 'inactive' {
  if (!lastPurchaseAt) return 'inactive';
  return now - lastPurchaseAt.getTime() <= ACTIVE_WINDOW_MS
    ? 'active'
    : 'inactive';
}
