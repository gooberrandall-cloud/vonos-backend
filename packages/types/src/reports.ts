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
}

export interface ReportsTable {
  columns: ReportsTableColumn[];
  rows: Array<Record<string, string | number>>;
}

export interface ReportsDashboard {
  kpis: ReportsKpi[];
  charts: ReportsChart[];
  table?: ReportsTable | null;
}
