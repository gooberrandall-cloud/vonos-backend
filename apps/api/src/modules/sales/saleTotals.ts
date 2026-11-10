export type SaleLineInput = {
  itemId?: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
  taxPercent?: number;
  createPurchase?: boolean;
  sourceTenantCode?: string;
  supplierId?: string;
};

export function normalizeTaxPercent(value?: number | null): number {
  const pct = Number(value ?? 0);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.min(pct, 100);
}

export function computeLineTotal(line: {
  quantity: number;
  unitPrice: number;
  discountAmount?: number | null;
}): number {
  const discount = line.discountAmount ?? 0;
  return Math.max(0, line.quantity * line.unitPrice - discount);
}

export function buildSaleLineRows(lines: SaleLineInput[]) {
  return lines.map((line) => {
    const discountAmount = line.discountAmount ?? 0;
    const lineTotal = computeLineTotal({ ...line, discountAmount });
    return {
      itemId: line.itemId ?? null,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal,
      discountAmount: discountAmount > 0 ? discountAmount : null,
      taxPercent: normalizeTaxPercent(line.taxPercent),
      sourceTenantCode: line.sourceTenantCode?.trim() || null,
      supplierId: line.supplierId?.trim() || null,
    };
  });
}

type SaleLineRow = {
  lineTotal: number;
  taxPercent?: number | null;
};

export function lineTaxTotal(lineRows: SaleLineRow[]): number {
  return lineRows.reduce(
    (sum, row) => sum + (row.lineTotal * normalizeTaxPercent(row.taxPercent)) / 100,
    0,
  );
}

export function combinedTaxAmount(orderTax: number, lineRows: SaleLineRow[]): number {
  return Math.max(0, orderTax) + lineTaxTotal(lineRows);
}

export function orderTaxFromPersistedTax(
  persistedTax: number,
  lineRows: SaleLineRow[],
): number {
  return Math.max(0, persistedTax - lineTaxTotal(lineRows));
}

export function computeSaleTotal(
  lineRows: SaleLineRow[],
  orderDiscount = 0,
  orderTax = 0,
): number {
  const subtotal = lineRows.reduce((sum, row) => sum + row.lineTotal, 0);
  const discount = Math.min(subtotal, Math.max(0, orderDiscount));
  const tax = combinedTaxAmount(orderTax, lineRows);
  return Math.max(0, subtotal - discount + tax);
}
