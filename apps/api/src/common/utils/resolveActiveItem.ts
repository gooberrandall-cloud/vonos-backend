import type { Item, Prisma } from '@prisma/client';

type DbClient = Prisma.TransactionClient | Prisma.DefaultPrismaClient;

/**
 * Resolve a stockable Item for sale/purchase stock mutations.
 * Prefer the line's itemId; if that row was soft-deleted (common after
 * catalog dedupe), fall back to a live same-tenant SKU twin.
 */
export async function resolveActiveItem(
  db: DbClient,
  opts: {
    tenantId: string;
    itemId?: string | null;
    sku?: string | null;
  },
): Promise<Item | null> {
  const itemId = opts.itemId?.trim() || null;
  if (itemId) {
    const byId = await db.item.findFirst({
      where: { id: itemId, tenantId: opts.tenantId, deletedAt: null },
    });
    if (byId) return byId;
  }

  const sku = opts.sku?.trim() || null;
  if (!sku) return null;

  return db.item.findFirst({
    where: { tenantId: opts.tenantId, sku, deletedAt: null },
  });
}
