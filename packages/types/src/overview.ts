import type { ReportsChart, ReportsKpi, ReportsTable } from "./reports";

export interface OverviewRankedItem {
  label: string;
  /** Units sold in the selected period */
  units: number;
  /** Line revenue in the selected period */
  revenue: number;
  currency?: string;
  itemId?: string | null;
}

export interface OverviewJobStatusSlice {
  label: string;
  value: number;
  color: string;
}

export interface OverviewTableStatus {
  available: number;
  occupied: number;
  reserved: number;
}

export interface OverviewTimelineBlock {
  id: string;
  stylist: string;
  hour: string;
  client: string;
  service: string;
  status: string;
}

/** HQ6 home dashboard bottom table panel (stock alert, payment dues, etc.) */
export interface OverviewPanel {
  id: string;
  title: string;
  columns: { key: string; header: string }[];
  rows: Record<string, string | number>[];
  viewAllRoute?: string | null;
}

export interface OverviewDashboard {
  kpis: ReportsKpi[];
  charts: ReportsChart[];
  /** HQ6-style finance KPI strip (revenue, expenses, purchase due, etc.) */
  financeKpis?: ReportsKpi[] | null;
  /** Finance panels (P&L trend, expense breakdown) — rendered below primary charts */
  financeCharts?: ReportsChart[] | null;
  /** HQ6 home bottom stacked operational tables */
  panels?: OverviewPanel[] | null;
  table?: ReportsTable | null;
  rankedList?: OverviewRankedItem[] | null;
  jobStatusPie?: OverviewJobStatusSlice[] | null;
  tableStatus?: OverviewTableStatus | null;
  timeline?: {
    hours: string[];
    stylists: string[];
    blocks: OverviewTimelineBlock[];
  } | null;
}

export interface GroupEntityStat {
  code: string;
  stats: [string, string, string];
}

export interface GroupOverviewAlert {
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  entityCode?: string;
  linkedRoute?: string;
}

export interface GroupOverviewDashboard extends OverviewDashboard {
  entityStats: GroupEntityStat[];
  alerts?: GroupOverviewAlert[];
}

/** Fast first paint for VAG home — KPIs + entity cards only. */
export interface GroupOverviewSummary {
  kpis: ReportsKpi[];
  entityStats: GroupEntityStat[];
}

/** Deferred second request — charts + alerts. */
export interface GroupOverviewDetails {
  charts: ReportsChart[];
  alerts: GroupOverviewAlert[];
}
