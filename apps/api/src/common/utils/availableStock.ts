import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';

/**
 * Available stock (AGENTS §15 v1):
 *   available = onHand − qty on Approved, unfulfilled requisition lines
 * for the given source tenant + SKU.
 *
 * Approved holds reduce sellable/transferable qty until fulfill or reject.
 * Pending requests do not reserve stock.
 */

export type AvailableStockBreakdown = {
  onHand: number;
  reserved: number;
  available: number;
};

/** Reserved qty by SKU for a source (fulfilling) tenant. */
export async function reservedQtyBySku(
  prisma: PrismaClient,
  sourceTenantId: string,
  skus?: string[],
): Promise<Map<string, number>> {
  const skuFilter =
    skus && skus.length > 0
      ? Prisma.sql`AND UPPER(line->>'sku') IN (${Prisma.join(
          skus.map((s) => Prisma.sql`${s.toUpperCase()}`),
        )})`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<Array<{ sku: string; reserved: bigint }>>`
    SELECT
      UPPER(line->>'sku') AS sku,
      COALESCE(SUM((line->>'quantity')::numeric), 0)::bigint AS reserved
    FROM "Requisition" r
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(r.lines::jsonb) = 'array' THEN r.lines::jsonb
        ELSE '[]'::jsonb
      END
    ) AS line
    WHERE r."sourceTenantId" = ${sourceTenantId}
      AND r.status = 'Approved'
      AND r."deletedAt" IS NULL
      AND COALESCE(line->>'sku', '') <> ''
      ${skuFilter}
    GROUP BY UPPER(line->>'sku')
  `;

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.sku, Number(row.reserved));
  }
  return map;
}

export function breakdownFromOnHand(
  onHand: number,
  reserved: number,
): AvailableStockBreakdown {
  const safeReserved = Math.max(0, reserved);
  return {
    onHand,
    reserved: safeReserved,
    available: Math.max(0, onHand - safeReserved),
  };
}

export async function computeAvailableStock(
  prisma: PrismaClient,
  sourceTenantId: string,
  sku: string,
  onHand: number,
): Promise<AvailableStockBreakdown> {
  const reservedMap = await reservedQtyBySku(prisma, sourceTenantId, [sku]);
  const reserved = reservedMap.get(sku.toUpperCase()) ?? 0;
  return breakdownFromOnHand(onHand, reserved);
}

/** Assert each line's requested qty fits available stock at the source. */
export async function assertSourceHasAvailableStock(
  prisma: PrismaClient,
  sourceTenantId: string,
  lines: Array<{ sku: string; quantity: number }>,
): Promise<void> {
  if (lines.length === 0) return;

  const skus = [...new Set(lines.map((l) => l.sku))];
  const items = await prisma.item.findMany({
    where: {
      tenantId: sourceTenantId,
      deletedAt: null,
      sku: { in: skus },
    },
    select: { sku: true, quantity: true },
  });
  const onHandBySku = new Map(
    items.map((item) => [item.sku.toUpperCase(), item.quantity]),
  );
  const reservedMap = await reservedQtyBySku(prisma, sourceTenantId, skus);

  const requestedBySku = new Map<string, number>();
  for (const line of lines) {
    const key = line.sku.toUpperCase();
    requestedBySku.set(key, (requestedBySku.get(key) ?? 0) + line.quantity);
  }

  for (const [sku, requested] of requestedBySku) {
    const onHand = onHandBySku.get(sku) ?? 0;
    const reserved = reservedMap.get(sku) ?? 0;
    const available = Math.max(0, onHand - reserved);
    if (requested > available) {
      throw new Error(
        `Insufficient available stock for SKU ${sku}: need ${requested}, available ${available} (on hand ${onHand}, reserved ${reserved})`,
      );
    }
  }
}
