import { pickCsvField } from './csvImport';

/** HQ6 Import Opening Stock column headers (order matches Instructions table). */
export const OPENING_STOCK_CSV_HEADERS = [
  'SKU',
  'Location',
  'Quantity',
  'Unit Cost (Before Tax)',
  'Lot Number',
  'Expiry Date',
] as const;

export type ParsedOpeningStockCsvRow = {
  sku: string;
  location?: string;
  quantity: number;
  unitCost: number;
  lotNumber?: string;
  expiryDate?: string;
};

/** Parse dd-mm-yyyy (business date format) into ISO date string (yyyy-mm-dd). */
export function parseDdMmYyyy(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(trimmed);
  if (!match) {
    throw new Error(
      'Expiry Date must be in format dd-mm-yyyy (e.g. 23-07-2026)',
    );
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid Expiry Date: ${trimmed}`);
  }
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid Expiry Date: ${trimmed}`);
  }
  return iso;
}

export function parseOpeningStockCsvRow(
  row: Record<string, string>,
): ParsedOpeningStockCsvRow {
  const sku = pickCsvField(row, 'sku', 'product sku');
  if (!sku) throw new Error('SKU is required');

  const quantityRaw = pickCsvField(row, 'quantity', 'qty', 'opening stock');
  const quantity = Number(quantityRaw);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Quantity is required and must be greater than zero');
  }

  const unitCostRaw = pickCsvField(
    row,
    'unit cost (before tax)',
    'unit cost',
    'cost',
    'cost price',
    'purchase price',
  );
  const unitCost = Number(unitCostRaw);
  if (!Number.isFinite(unitCost) || unitCost < 0) {
    throw new Error('Unit Cost (Before Tax) is required');
  }

  const location =
    pickCsvField(row, 'location', 'opening stock location') || undefined;
  const lotNumber = pickCsvField(row, 'lot number', 'lot') || undefined;
  const expiryDate = parseDdMmYyyy(pickCsvField(row, 'expiry date', 'exp date'));

  return {
    sku,
    location,
    quantity: Math.trunc(quantity),
    unitCost,
    lotNumber,
    expiryDate,
  };
}

export function isOpeningStockCsv(rows: Record<string, string>[]): boolean {
  if (rows.length === 0) return false;
  const sample = rows[0] ?? {};
  return Boolean(
    pickCsvField(sample, 'unit cost (before tax)') ||
      (pickCsvField(sample, 'sku') &&
        pickCsvField(sample, 'quantity') &&
        pickCsvField(sample, 'location') !== undefined &&
        Object.prototype.hasOwnProperty.call(sample, 'location')),
  );
}
