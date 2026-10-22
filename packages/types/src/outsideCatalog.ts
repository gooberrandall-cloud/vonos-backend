/**
 * Outside-purchase / labour / service catalog lines (OT).
 * These are billed like products but are not warehouse stock — no qty-on-hand,
 * no "X left", and sales/purchases must not adjust Item.quantity.
 */
export function isOutsideOrServiceCatalogItem(input: {
  name?: string | null;
  sku?: string | null;
  category?: string | null;
}): boolean {
  const name = (input.name ?? "").trim();
  const sku = (input.sku ?? "").trim();
  const category = (input.category ?? "").trim();
  if (!name && !sku && !category) return false;

  // Explicit OT marker (Outside / Other suppliers)
  if (/\bOT\b/i.test(name) || /\bOT\b/i.test(sku) || /\bOT\b/i.test(category)) {
    return true;
  }
  if (/other\s+suppliers/i.test(category)) return true;

  // Labour / service phrasing (not physical parts)
  if (
    /^(fixing|clearing|repair(?:ing)?|servicing|labour|labor|welding|painting|installation|installing|alignment|balancing|administration)\b/i.test(
      name,
    )
  ) {
    return true;
  }
  if (
    /^(body\s*work|labour|labor|transport|painting|alignment|balancing)/i.test(
      category,
    )
  ) {
    return true;
  }
  return false;
}
