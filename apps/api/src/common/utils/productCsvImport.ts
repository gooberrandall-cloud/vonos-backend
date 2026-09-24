import { pickCsvField } from './csvImport';

/** HQ6 / Ultimate POS product import column headers (order matches Instructions table). */
export const PRODUCT_CSV_HEADERS = [
  'Product Name',
  'Brand',
  'Unit',
  'Category',
  'Sub Category',
  'SKU',
  'Barcode Type',
  'Manage Stock?',
  'Alert quantity',
  'Expires in',
  'Expiry Period Unit',
  'Applicable Tax',
  'Selling Price Tax Type',
  'Product Type',
  'Variation Name',
  'Variation Values',
  'Variation SKUs',
  'Purchase Price (Including Tax)',
  'Purchase Price (Excluding Tax)',
  'Profit Margin %',
  'Selling Price',
  'Opening Stock',
  'Opening stock location',
  'Expiry Date',
  'Enable Product description, IMEI or Serial Number',
  'Weight',
  'Rack',
  'Row',
  'Position',
  'Image',
  'Product Description',
  'Custom Field 1',
  'Custom Field 2',
  'Custom Field 3',
  'Custom Field 4',
  'Not for selling',
  'Product locations',
] as const;

export type ProductCsvVariantRow = {
  name: string;
  sku: string;
  costPrice: number;
  sellPrice: number;
  quantity: number;
  binLocation?: string;
};

export type ParsedProductCsvRow = {
  productName: string;
  brandName?: string;
  unit: string;
  category?: string;
  subCategory?: string;
  barcodeType?: string;
  manageStock: boolean;
  alertQuantity?: number;
  sellingPriceTaxType: 'inclusive' | 'exclusive';
  productType: 'single' | 'variable';
  variationName?: string;
  variationValues: string[];
  enableImei: boolean;
  weight?: string;
  description?: string;
  availableForRetail: boolean;
  openingStockLocation?: string;
  productLocations: string[];
  variants: ProductCsvVariantRow[];
};

function splitPipe(value: string): string[] {
  if (!value.trim()) return [];
  return value.split('|').map((part) => part.trim());
}

function splitComma(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseBool01(raw: string, field: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'yes' || v === 'true') return true;
  if (v === '0' || v === 'no' || v === 'false' || v === '') return false;
  throw new Error(`${field} must be 1 or 0`);
}

function parseRequiredBool01(raw: string, field: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'yes' || v === 'true') return true;
  if (v === '0' || v === 'no' || v === 'false') return false;
  throw new Error(`${field} is required (1 = Yes, 0 = No)`);
}

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function encodeBin(rack: string, row: string, position: string): string | undefined {
  const parts = [
    rack.trim() ? `Rack ${rack.trim()}` : '',
    row.trim() ? `Row ${row.trim()}` : '',
    position.trim() ? `Pos ${position.trim()}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function autoSku(productName: string, index: number, variantIndex?: number): string {
  const slug = productName
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 16)
    .toUpperCase();
  const base = `PRD-${slug || 'ITEM'}-${Date.now().toString(36).toUpperCase()}-${index + 1}`;
  return variantIndex != null ? `${base}-V${variantIndex + 1}` : base;
}

function pickAt(values: string[], index: number): string {
  if (values.length === 0) return '';
  if (index < values.length) return values[index] ?? '';
  return values[0] ?? '';
}

/**
 * Parse one HQ6 product import row into one or more create payloads
 * (variable products expand to one item per variation value).
 */
export function parseProductCsvRow(
  row: Record<string, string>,
  rowIndex: number,
  defaultProfitMarginPercent = 0,
): ParsedProductCsvRow {
  const productName = pickCsvField(row, 'product name', 'name');
  if (!productName) throw new Error('Product Name is required');

  const unit = pickCsvField(row, 'unit');
  if (!unit) throw new Error('Unit is required');

  const manageStockRaw = pickCsvField(row, 'manage stock?', 'manage stock');
  const manageStock = parseRequiredBool01(manageStockRaw, 'Manage Stock?');

  const taxTypeRaw = pickCsvField(
    row,
    'selling price tax type',
    'tax type',
  ).toLowerCase();
  if (taxTypeRaw !== 'inclusive' && taxTypeRaw !== 'exclusive') {
    throw new Error('Selling Price Tax Type is required (inclusive or exclusive)');
  }

  const productTypeRaw = pickCsvField(row, 'product type', 'type').toLowerCase();
  if (productTypeRaw !== 'single' && productTypeRaw !== 'variable') {
    throw new Error('Product Type is required (single or variable)');
  }

  const variationName = pickCsvField(row, 'variation name') || undefined;
  const variationValues = splitPipe(pickCsvField(row, 'variation values'));
  const variationSkus = splitPipe(pickCsvField(row, 'variation skus'));
  const purchaseIncl = splitPipe(
    pickCsvField(
      row,
      'purchase price (including tax)',
      'purchase price including tax',
      'purchase price (incl. tax)',
    ),
  );
  const purchaseExcl = splitPipe(
    pickCsvField(
      row,
      'purchase price (excluding tax)',
      'purchase price excluding tax',
      'purchase price (excl. tax)',
      'purchase price',
      'cost',
      'cost price',
    ),
  );
  const sellingPrices = splitPipe(
    pickCsvField(row, 'selling price', 'sell price', 'price'),
  );
  const openingStocks = splitPipe(
    pickCsvField(row, 'opening stock', 'quantity', 'stock'),
  );
  const racks = splitPipe(pickCsvField(row, 'rack'));
  const rows = splitPipe(pickCsvField(row, 'row'));
  const positions = splitPipe(pickCsvField(row, 'position'));

  if (productTypeRaw === 'variable') {
    if (!variationName) throw new Error('Variation Name is required for variable products');
    if (variationValues.length === 0) {
      throw new Error('Variation Values are required for variable products');
    }
  }

  const marginRaw = pickCsvField(row, 'profit margin %', 'profit margin', 'margin');
  const margin =
    parseNumber(marginRaw) ??
    (Number.isFinite(defaultProfitMarginPercent) ? defaultProfitMarginPercent : 0);

  const alertRaw = pickCsvField(row, 'alert quantity', 'reorder point', 'reorder_point');
  const alertQuantity = parseNumber(alertRaw) ?? undefined;

  const notForSelling = parseBool01(
    pickCsvField(row, 'not for selling'),
    'Not for selling',
  );
  const enableImei = parseBool01(
    pickCsvField(
      row,
      'enable product description, imei or serial number',
      'enable imei',
      'enable product description',
    ),
    'Enable Product description, IMEI or Serial Number',
  );

  const baseSku = pickCsvField(row, 'sku', 'product sku');
  const brandName = pickCsvField(row, 'brand') || undefined;
  const category = pickCsvField(row, 'category') || undefined;
  const subCategory = pickCsvField(row, 'sub category', 'subcategory') || undefined;
  const barcodeType =
    pickCsvField(row, 'barcode type') || (productTypeRaw === 'single' ? 'C128' : undefined);
  const weight = pickCsvField(row, 'weight') || undefined;
  const description =
    pickCsvField(row, 'product description', 'description') || undefined;
  const openingStockLocation =
    pickCsvField(row, 'opening stock location') || undefined;
  const productLocations = splitComma(pickCsvField(row, 'product locations'));

  const variantKeys =
    productTypeRaw === 'variable' ? variationValues : [''];

  const variants: ProductCsvVariantRow[] = variantKeys.map((value, vi) => {
    const excl = parseNumber(pickAt(purchaseExcl, vi));
    const incl = parseNumber(pickAt(purchaseIncl, vi));
    if (excl == null && incl == null) {
      throw new Error(
        'Purchase Price (Including Tax) or Purchase Price (Excluding Tax) is required',
      );
    }
    const costPrice = excl ?? incl ?? 0;
    if (costPrice < 0) throw new Error('Invalid purchase price');

    const sellRaw = parseNumber(pickAt(sellingPrices, vi));
    const sellPrice =
      sellRaw != null && sellRaw >= 0
        ? sellRaw
        : Math.round(costPrice * (1 + margin / 100) * 100) / 100;

    const qtyRaw = parseNumber(pickAt(openingStocks, vi));
    const quantity = manageStock ? Math.max(0, Math.trunc(qtyRaw ?? 0)) : 0;

    const skuFromCsv =
      productTypeRaw === 'variable'
        ? pickAt(variationSkus, vi) || (vi === 0 ? baseSku : '')
        : baseSku;
    const sku =
      skuFromCsv.trim() ||
      autoSku(productName, rowIndex, productTypeRaw === 'variable' ? vi : undefined);

    const name =
      productTypeRaw === 'variable' && value
        ? `${productName} - ${value}`
        : productName;

    const binLocation = encodeBin(
      pickAt(racks, vi),
      pickAt(rows, vi),
      pickAt(positions, vi),
    );

    return { name, sku, costPrice, sellPrice, quantity, binLocation };
  });

  return {
    productName,
    brandName,
    unit,
    category,
    subCategory,
    barcodeType: barcodeType || 'C128',
    manageStock,
    alertQuantity: manageStock ? alertQuantity : undefined,
    sellingPriceTaxType: taxTypeRaw,
    productType: productTypeRaw,
    variationName,
    variationValues,
    enableImei,
    weight,
    description,
    availableForRetail: !notForSelling,
    openingStockLocation,
    productLocations,
    variants,
  };
}

/** Detect whether the CSV looks like the HQ6 37-column product template. */
export function isHq6ProductCsv(rows: Record<string, string>[]): boolean {
  if (rows.length === 0) return false;
  const sample = rows[0] ?? {};
  return Boolean(
    pickCsvField(sample, 'product name') ||
      pickCsvField(sample, 'manage stock?') ||
      pickCsvField(sample, 'selling price tax type') ||
      pickCsvField(sample, 'product type'),
  );
}
