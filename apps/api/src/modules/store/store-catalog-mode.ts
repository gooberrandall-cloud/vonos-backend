/** Production hides non-retail / out-of-status items. Dev shows all priced VSP stock for testing. */
export function isStrictStoreCatalog(): boolean {
  if (process.env.STORE_CATALOG_STRICT === "true") return true;
  if (process.env.STORE_CATALOG_STRICT === "false") return false;
  return process.env.NODE_ENV === "production";
}
