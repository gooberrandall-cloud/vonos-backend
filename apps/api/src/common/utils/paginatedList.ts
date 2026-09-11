import type { Prisma } from '@prisma/client';

/** Shared list envelope for cursor-paginated endpoints. */
export interface ListAmountSummary {
  totalAmount?: number;
  totalPaid?: number;
  totalDue?: number;
  currency?: string;
}

export interface PaginatedList<T> {
  items: T[];
  /** True when another page may exist (full page returned). */
  hasMore?: boolean;
  pageSize?: number;
  /** Filtered row count. Omitted when `includeSummary=0` (rows-first paint). */
  totalCount?: number;
  amountSummary?: ListAmountSummary;
}

export function isPaginatedList<T>(
  value: unknown,
): value is PaginatedList<T> {
  return (
    typeof value === 'object' &&
    value != null &&
    Array.isArray((value as PaginatedList<T>).items)
  );
}

/** Strip cursor clause so count matches the full filtered set. */
export type ListWhere = Prisma.JsonObject;
