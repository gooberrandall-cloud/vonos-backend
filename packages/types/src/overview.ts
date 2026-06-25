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

export interface OverviewDashboard {
  kpis: ReportsKpi[];
  charts: ReportsChart[];
  /** Finance panels (P&L trend, expense breakdown) — rendered below primary charts */
  financeCharts?: ReportsChart[] | null;
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
