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

/** Composite cursor filter aligned with `orderBy: [{ [sortField], id }]`. */
export function buildCompositeCursorWhere(
  sortField: string,
  sortDir: SortDirection,
  cursor: CompositeCursor | null,
  sortValueType: 'string' | 'date' | 'number' = 'string',
): Prisma.JsonObject | undefined {
  if (!cursor?.id) return undefined;

  const op = compareOp(sortDir);
  const parsedSort =
    sortValueType === 'date'
      ? cursor.sortValue
        ? new Date(cursor.sortValue)
        : new Date(0)
      : sortValueType === 'number'
        ? Number(cursor.sortValue)
        : cursor.sortValue;

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
  const limit = options.limit ?? 10;
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
  if (sortValueType === 'date' && sortValue && !sortValue.includes('T')) {
    sortValue = new Date(sortValue).toISOString();
  }
  return encodeCompositeCursor({ sortValue, id: row.id });
}
