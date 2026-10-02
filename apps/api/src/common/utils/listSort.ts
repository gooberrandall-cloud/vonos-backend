import type { SortDirection } from './pagination';

export type SortValueType = 'string' | 'date' | 'number';

export interface SortFieldConfig {
  field: string;
  type: SortValueType;
}

export interface ResolvedListSort {
  sortField: string;
  sortDir: SortDirection;
  sortValueType: SortValueType;
}

/** Map client sortBy keys to Prisma fields; fall back when unknown. */
export function resolveListSort(
  sortBy: string | undefined,
  sortDir: string | undefined,
  allowed: Record<string, SortFieldConfig>,
  fallback: ResolvedListSort,
): ResolvedListSort {
  const mapped = sortBy ? allowed[sortBy] : undefined;
  const dir: SortDirection =
    sortDir === 'asc' || sortDir === 'desc' ? sortDir : fallback.sortDir;
  if (!mapped) return fallback;
  return {
    sortField: mapped.field,
    sortDir: dir,
    sortValueType: mapped.type,
  };
}
