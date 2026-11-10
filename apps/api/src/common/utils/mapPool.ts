/**
 * Run async work over `items` with at most `limit` in flight (Neon-safe).
 * Prefer this over unbounded Promise.all against the pooler.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!, index);
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, () => runWorker()),
  );
  return results;
}

type AwaitedFactory<F> = F extends () => Promise<infer R> ? R : never;

/**
 * Await an array of promise factories with max concurrency.
 * Preserves heterogeneous tuple result types (like Promise.all).
 */
export async function runPool<const T extends readonly (() => Promise<unknown>)[]>(
  factories: T,
  limit: number,
): Promise<{ [K in keyof T]: AwaitedFactory<T[K]> }> {
  const results = await mapPool(factories, limit, (factory) => factory());
  return results as { [K in keyof T]: AwaitedFactory<T[K]> };
}
