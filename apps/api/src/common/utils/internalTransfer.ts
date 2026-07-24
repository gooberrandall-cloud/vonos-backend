import { Prisma } from '@prisma/client';

/** Categories/descriptions for internal Warehouse ↔ entity stock moves. */
export const INTERNAL_TRANSFER_MARKERS = [
  'internal transfer',
  'stock transfer',
  'requisition fulfillment',
  'inter-entity transfer',
] as const;

/**
 * Group P&L exclusion: prefer explicit `isInternalTransfer` flag;
 * keep text markers as a safety net for legacy untagged rows.
 */
export const EXCLUDE_INTERNAL_TRANSFER_SQL = Prisma.sql`
  AND "isInternalTransfer" = false
  AND NOT (
    LOWER(COALESCE(category, '') || ' ' || COALESCE(description, '')) LIKE '%internal transfer%'
    OR LOWER(COALESCE(category, '') || ' ' || COALESCE(description, '')) LIKE '%stock transfer%'
    OR LOWER(COALESCE(category, '') || ' ' || COALESCE(description, '')) LIKE '%requisition fulfillment%'
    OR LOWER(COALESCE(category, '') || ' ' || COALESCE(description, '')) LIKE '%inter-entity transfer%'
  )
`;

export function isInternalTransferEntry(
  category: string,
  description: string,
  flagged = false,
): boolean {
  if (flagged) return true;
  const haystack = `${category} ${description}`.toLowerCase();
  return INTERNAL_TRANSFER_MARKERS.some((marker) => haystack.includes(marker));
}
