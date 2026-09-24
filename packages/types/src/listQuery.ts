/** Shared list sort query params (cursor pagination). */
export type ListSortDirection = "asc" | "desc";

export interface ListSort {
  sortBy?: string;
  sortDir?: ListSortDirection;
}
