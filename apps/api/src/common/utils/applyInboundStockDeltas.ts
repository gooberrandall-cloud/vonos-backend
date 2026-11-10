import { BadRequestException } from '@nestjs/common';
import type { Item, Prisma } from '@prisma/client';
import { shouldAdjustLocalItemStock } from '@vonos/types';
import { adjustItemLocationStock } from './itemLocationStock';
import { computeStockStatus } from './stockQuantity';
import { resolveActiveItem } from './resolveActiveItem';

type DbClient = Prisma.TransactionClient;

export type InboundStockLineMeta = {
  sku?: string;
  name?: string;
};

export type InboundStockTenantContext = {
  code?: string | null;
  archetype?: string | null;
};

export function inboundStockLineLookup(
  lines: Array<{ itemId: string; sku?: string; name?: string }>,
): Map<string, InboundStockLineMeta> {
  const out = new Map<string, InboundStockLineMeta>();
  for (const line of lines) {
    out.set(line.itemId, { sku: line.sku, name: line.name });
  }
  return out;
}

/**
 * Apply per-item quantity deltas inside a purchase/movement transaction.
 * Batch-loads items then applies updates in parallel to cut round-trips.
 */
export async function applyInboundStockDeltas(
  tx: DbClient,
  opts: {
    tenantId: string;
    tenant?: InboundStockTenantContext;
    qtyByItem: Map<string, number>;
    lineLookup: Map<string, InboundStockLineMeta>;
    locationCode: string | null | undefined;
  },
): Promise<void> {
  const tenantCtx = opts.tenant ?? {};
  if (!shouldAdjustLocalItemStock(tenantCtx, null)) {
    return;
  }

  const work = [...opts.qtyByItem.entries()].filter(([, delta]) => delta !== 0);
  if (work.length === 0) return;

  const itemIds = work.map(([itemId]) => itemId);
  const fetched = await tx.item.findMany({
    where: {
      tenantId: opts.tenantId,
      id: { in: itemIds },
      deletedAt: null,
    },
  });
  const byId = new Map(fetched.map((row) => [row.id, row]));

  await Promise.all(
    work.map(async ([itemId, delta]) => {
      let item: Item | null = byId.get(itemId) ?? null;
      if (!item) {
        const meta = opts.lineLookup.get(itemId);
        item = await resolveActiveItem(tx, {
          tenantId: opts.tenantId,
          itemId,
          sku: meta?.sku,
        });
      }
      if (!item) {
        throw new BadRequestException(`Item not found: ${itemId}`);
      }
      if (
        !shouldAdjustLocalItemStock(tenantCtx, {
          name: item.name,
          sku: item.sku,
          category: item.category,
        })
      ) {
        return;
      }
      const nextQuantity = item.quantity + delta;
      if (nextQuantity < 0) {
        throw new BadRequestException(
          `Insufficient stock for ${item.sku} (delta ${delta}, have ${item.quantity})`,
        );
      }
      await tx.item.update({
        where: { id: item.id },
        data: {
          quantity: nextQuantity,
          status: computeStockStatus(nextQuantity, item.reorderPoint),
        },
      });
      await adjustItemLocationStock(tx, {
        tenantId: opts.tenantId,
        itemId: item.id,
        locationCode: opts.locationCode ?? item.locationCode,
        binLocation: item.binLocation,
        delta,
      });
    }),
  );
}
