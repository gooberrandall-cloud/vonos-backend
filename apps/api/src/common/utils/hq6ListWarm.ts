/**
 * HQ6 list warm keys must match what the browser actually requests
 * (pageSize 25 + default sort + rows-first sum=0). Mismatched keys = cache miss = Neon cold.
 */
export const HQ6_LIST_WARM_LIMITS = [25] as const;

export type Hq6WarmSort = {
  sortBy: string | undefined;
  sortDir: string | undefined;
};

/** Primary UI sorts + undefined (clients that omit sortBy). */
export function hq6WarmSorts(
  primary: Hq6WarmSort = { sortBy: 'updatedAt', sortDir: 'desc' },
): Hq6WarmSort[] {
  return [primary, { sortBy: undefined, sortDir: undefined }];
}
