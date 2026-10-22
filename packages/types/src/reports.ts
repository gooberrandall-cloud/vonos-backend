export interface ReportsKpi {
  label: string;
  icon: string;
  metricKey: string;
  color: string;
  value: number;
  currency?: string;
  delta?: number;
  deltaLabel?: string;
  deltaPercent?: string;
}

export interface ReportsChartSeries {
  name: string;
  dataKey: string;
  color: string;
}

export interface ReportsChart {
  id: string;
  title: string;
  subtitle?: string;
  type: "bar" | "line" | "pie";
  horizontal?: boolean;
  series: ReportsChartSeries[];
  data: Array<{ label: string } & Record<string, string | number>>;
}

export interface ReportsTableColumn {
  key: string;
  header: string;
  /** When set, footer totals treat this column as currency or quantity. */
  totalAs?: "currency" | "number";
}

/** HQ6-style row action (fix stock, edit expiry, view linked record). */
export type ReportRowActionKind =
  | "view-record"
  | "fix-stock"
  | "edit-expiry"
  | "edit-payment";

export interface ReportRowAction {
  kind: ReportRowActionKind;
  label: string;
  payload: Record<string, string | number>;
}

export interface ReportsTableRow {
  id?: string;
  recordType?: string;
  actions?: ReportRowAction[];
  [key: string]: string | number | ReportRowAction[] | undefined;
}

export interface ReportsTable {
  columns: ReportsTableColumn[];
  rows: ReportsTableRow[];
  /** Present when the table is server cursor-paginated (e.g. expense report). */
  hasMore?: boolean;
  nextCursor?: string | null;
  pageSize?: number;
  /**
   * Full filtered-range totals for summable columns (preferred over page sums).
   * Keys match column keys; values are numeric aggregates.
   */
  columnTotals?: Record<string, number>;
}

/** HQ6-style P&L line (debit = left column, credit = right column). */
export interface ProfitLossLine {
  key: string;
  label: string;
  amount: number;
}

export type ProfitLossBreakdownTab =
  | "product"
  | "category"
  | "brand"
  | "location"
  | "invoice"
  | "date"
  | "customer"
  | "day"
  | "service-staff";

export interface ProfitLossSummary {
  currency: string;
  debits: ProfitLossLine[];
  credits: ProfitLossLine[];
  cogs: number;
  grossProfit: number;
  netProfit: number;
}

export interface ProfitLossReport {
  summary: ProfitLossSummary;
  breakdowns: Partial<Record<ProfitLossBreakdownTab, ReportsTable>>;
}

export interface GroupReportEntityRollup {
  code: string;
  rows: Record<string, string | number>[];
}

/** Ultimate POS–style tax report top summary cards. */
export interface TaxReportSummary {
  currency: string;
  purchases: {
    total: number;
    includingTax: number;
    returnIncludingTax: number;
    due: number;
  };
  sales: {
    total: number;
    includingTax: number;
    returnIncludingTax: number;
    due: number;
  };
  overall: {
    /** (Sale − Sell Return) − (Purchase − Purchase Return) */
    saleMinusPurchase: number;
    /** Sale Due − Purchase Due */
    dueAmount: number;
  };
}

/** HQ6-style balance sheet line (liability or asset side). */
export interface BalanceSheetLine {
  key: string;
  label: string;
  amount: number;
}

export interface BalanceSheetAccountLine {
  id: string;
  name: string;
  balance: number;
}

/** Two-column balance sheet — liabilities vs assets. */
export interface BalanceSheetReport {
  currency: string;
  liabilities: BalanceSheetLine[];
  assets: BalanceSheetLine[];
  accountBalances: BalanceSheetAccountLine[];
  totalLiability: number;
  totalAssets: number;
}

/** Cash flow / account book ledger line with running balances. */
export interface CashFlowRow {
  id: string;
  date: string;
  account: string;
  description: string;
  paymentMethod: string;
  receiptVoucher: string;
  debit: number | null;
  credit: number | null;
  previousBalance: number;
  totalBalance: number;
}

export interface CashFlowReport {
  currency: string;
  rows: CashFlowRow[];
  totals: {
    debit: number;
    credit: number;
    balance: number;
  };
}

/** HQ6 tax / purchase-sale detail — separate purchase vs sale invoice tables. */
export interface TaxReportTables {
  purchases: ReportsTable;
  sales: ReportsTable;
}

export interface ReportsDashboard {
  kpis: ReportsKpi[];
  charts: ReportsChart[];
  table?: ReportsTable | null;
  /** Present for profit-loss report — HQ6 two-column layout + breakdown tabs. */
  profitLoss?: ProfitLossReport;
  /** Present for tax report — Purchases / Sales / Overall cards. */
  taxReport?: TaxReportSummary;
  /** Present for tax / purchase-sale — Input (purchases) vs Output (sales) tables. */
  taxTables?: TaxReportTables;
  /** Present for balance sheet report — liability vs assets columns. */
  balanceSheet?: BalanceSheetReport;
  /** Present for cash flow report — ledger with running balances. */
  cashFlow?: CashFlowReport;
  /** VAG group roll-up: per-entity rows for the active report. */
  byEntity?: GroupReportEntityRollup[];
}

/** Query options for paginated / filtered table reports. */
export type ProductSellReportView = "detailed" | "by-category" | "by-brand";

export type TaxReportTableSide = "purchases" | "sales";

export interface ReportRunOptions {
  cursor?: string;
  limit?: number;
  search?: string;
  customerId?: string;
  customerGroupId?: string;
  locationCode?: string;
  /** Payment account filter (payment-account-report). */
  accountId?: string;
  category?: string;
  brandId?: string;
  paymentMethod?: string;
  supplierId?: string;
  view?: ProductSellReportView;
  /** Paginate one side of tax / purchase-sale invoice tables. */
  taxTable?: TaxReportTableSide;
}

/** Report ids that support cursor-paginated tables + filter cards. */
export const PAGINATED_TABLE_REPORT_IDS = [
  "expense",
  "product-sell",
  "product-purchase",
  "sell-payment",
  "purchase-payment",
  "items",
  "customer-groups",
] as const;

export type PaginatedTableReportId = (typeof PAGINATED_TABLE_REPORT_IDS)[number];

export function isPaginatedTableReport(
  reportId: string,
): reportId is PaginatedTableReportId {
  return (PAGINATED_TABLE_REPORT_IDS as readonly string[]).includes(reportId);
}
