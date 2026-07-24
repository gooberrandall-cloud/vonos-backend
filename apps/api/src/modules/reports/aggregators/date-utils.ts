import type { ReportsKpi } from '@vonos/types';

export interface DateWindow {
  from: Date;
  to: Date;
}

/** Max span for report/finance queries — prevents full-history scans. */
export const MAX_QUERY_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

function capWindow(from: Date, to: Date): DateWindow {
  const spanMs = to.getTime() - from.getTime();
  if (spanMs <= MAX_QUERY_WINDOW_MS) {
    return { from, to };
  }
  return {
    from: new Date(to.getTime() - MAX_QUERY_WINDOW_MS),
    to,
  };
}

export function resolveDateWindow(from?: string, to?: string): DateWindow {
  const toDate = to ? new Date(to) : new Date();
  // No query params = capped recent window (UI "All time" maps to same cap client-side).
  if (!from && !to) {
    return capWindow(
      new Date(toDate.getTime() - MAX_QUERY_WINDOW_MS),
      toDate,
    );
  }
  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  return capWindow(fromDate, toDate);
}

/** Matches web default (last_7_days) + 5-minute bucket keys for cache alignment. */
export function defaultVagOverviewApiBounds(now = new Date()): {
  from: string;
  to: string;
} {
  const bucketMs = 5 * 60 * 1000;
  const floorIso = (d: Date): string =>
    new Date(Math.floor(d.getTime() / bucketMs) * bucketMs).toISOString();
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  return { from: floorIso(start), to: floorIso(now) };
}

export function priorWindow(window: DateWindow): DateWindow {
  const spanMs = window.to.getTime() - window.from.getTime();
  const priorTo = new Date(window.from.getTime());
  const priorFrom = new Date(window.from.getTime() - spanMs);
  return { from: priorFrom, to: priorTo };
}

export type ChartDatum = { label: string } & Record<string, string | number>;

/** Satisfies ReportsChart.data typing for SQL aggregate row shapes. */
export function asChartData<T extends { label: string }>(
  rows: T[],
): ChartDatum[] {
  return rows as ChartDatum[];
}

export function inWindow(date: Date, window: DateWindow): boolean {
  const t = date.getTime();
  return t >= window.from.getTime() && t <= window.to.getTime();
}

export function bucketLabel(date: Date, spanDays: number): string {
  if (spanDays <= 2) {
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
    });
  }
  if (spanDays <= 60) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

export function bucketKey(date: Date, spanDays: number): string {
  if (spanDays <= 2) {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
  }
  if (spanDays <= 60) {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }
  return `${date.getFullYear()}-${date.getMonth()}`;
}

export function buildTimeSeries<T extends { date: Date }>(
  rows: T[],
  window: DateWindow,
  valueFn: (row: T) => number,
): Array<{ label: string; value: number }> {
  const spanDays =
    (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
  const buckets = new Map<string, { label: string; value: number }>();

  for (const row of rows) {
    if (!inWindow(row.date, window)) continue;
    const key = bucketKey(row.date, spanDays);
    const existing = buckets.get(key);
    const label = bucketLabel(row.date, spanDays);
    if (existing) {
      existing.value += valueFn(row);
    } else {
      buckets.set(key, { label, value: valueFn(row) });
    }
  }

  return Array.from(buckets.values()).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

export function computeDelta(
  current: number,
  prior: number,
): Pick<ReportsKpi, 'delta' | 'deltaLabel' | 'deltaPercent'> {
  if (prior === 0 && current === 0) {
    return { delta: 0, deltaLabel: 'vs prior period', deltaPercent: '0%' };
  }
  const delta = current - prior;
  const pct =
    prior === 0 ? (current > 0 ? 100 : 0) : Math.round((delta / prior) * 100);
  return {
    delta,
    deltaLabel: 'vs prior period',
    deltaPercent: `${pct >= 0 ? '+' : ''}${pct}%`,
  };
}

export function sumInWindow<T extends { date: Date }>(
  rows: T[],
  window: DateWindow,
  valueFn: (row: T) => number,
): number {
  return rows.reduce((sum, row) => {
    if (!inWindow(row.date, window)) return sum;
    return sum + valueFn(row);
  }, 0);
}

export function countInWindow<T extends { date: Date }>(
  rows: T[],
  window: DateWindow,
): number {
  return rows.filter((row) => inWindow(row.date, window)).length;
}
