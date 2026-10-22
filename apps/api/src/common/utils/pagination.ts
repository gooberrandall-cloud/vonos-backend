import type { Prisma } from '@prisma/client';

export type SortDirection = 'asc' | 'desc';

export interface CompositeCursor {
  sortValue: string;
  id: string;
}

export function encodeCompositeCursor(cursor: CompositeCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCompositeCursor(raw?: string): CompositeCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as CompositeCursor;
    if (parsed?.id) return parsed;
  } catch {
    // Legacy id-only cursors.
    return { sortValue: '', id: raw };
  }
  return null;
}

/** @deprecated Prefer buildCompositeCursorQuery for sorted lists. */
export function buildCursorQuery(cursor?: string, limit = 20) {
  return {
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  };
}

function compareOp(dir: SortDirection): 'lt' | 'gt' {
  return dir === 'desc' ? 'lt' : 'gt';
}

function parseCompositeSortValue(
  sortValue: string,
  sortValueType: 'string' | 'date' | 'number',
): string | number | Date | null {
  if (sortValueType === 'date') {
    if (!sortValue.trim()) return new Date(0);
    const parsed = new Date(sortValue);
    // Name/id cursors sent against a date sort produce Invalid Date and crash Prisma.
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }
  if (sortValueType === 'number') {
    const n = Number(sortValue);
    return Number.isFinite(n) ? n : null;
  }
  return sortValue;
}

/** Composite cursor filter aligned with `orderBy: [{ [sortField], id }]`. */
export function buildCompositeCursorWhere(
  sortField: string,
  sortDir: SortDirection,
  cursor: CompositeCursor | null,
  sortValueType: 'string' | 'date' | 'number' = 'string',
): Prisma.JsonObject | undefined {
  if (!cursor?.id) return undefined;

  const op = compareOp(sortDir);
  const parsedSort = parseCompositeSortValue(
    cursor.sortValue ?? '',
    sortValueType,
  );
  // Unusable cursor (e.g. product name encoded while API sorts by updatedAt).
  if (parsedSort == null) return undefined;

  return {
    OR: [
      { [sortField]: { [op]: parsedSort } },
      {
        AND: [
          { [sortField]: parsedSort },
          { id: { [op]: cursor.id } },
        ],
      },
    ],
  } as Prisma.JsonObject;
}

export function buildCompositeCursorQuery(options: {
  sortField: string;
  sortDir: SortDirection;
  cursor?: string;
  limit?: number;
  sortValueType?: 'string' | 'date' | 'number';
}) {
  // Prisma `take` must be a positive int — reject -1 ("All") and other bad values.
  const rawLimit = options.limit ?? 10;
  const limit = Math.min(Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 10), 1000);
  const decoded = decodeCompositeCursor(options.cursor);
  const cursorWhere = buildCompositeCursorWhere(
    options.sortField,
    options.sortDir,
    decoded,
    options.sortValueType,
  );

  return {
    take: limit,
    ...(cursorWhere ? { where: cursorWhere } : {}),
  };
}

export function nextCompositeCursor<T extends { id: string }>(
  row: T,
  sortField: keyof T,
  sortValueType: 'string' | 'date' | 'number' = 'string',
): string {
  const raw = row[sortField];
  let sortValue = '';
  if (raw instanceof Date) {
    sortValue = raw.toISOString();
  } else if (typeof raw === 'number') {
    sortValue = String(raw);
  } else if (raw != null) {
    sortValue = String(raw);
  }
  if (sortValueType === 'date') {
    const parsed = sortValue ? new Date(sortValue) : new Date(0);
    sortValue = Number.isNaN(parsed.getTime())
      ? new Date(0).toISOString()
      : parsed.toISOString();
  }
  return encodeCompositeCursor({ sortValue, id: row.id });
}
