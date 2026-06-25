export function buildCursorQuery(cursor?: string, limit = 20) {
  return {
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  };
}
