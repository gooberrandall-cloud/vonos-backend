import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { priorWindow, resolveDateWindow, type DateWindow } from './date-utils';
import { stockMetrics, type StockMetrics } from './stockReportQueries';

export interface StockReportContext {
  window: DateWindow;
  prior: DateWindow;
  todayWindow: DateWindow;
  tenantId: string;
  metrics: StockMetrics;
}

export async function loadStockReportContext(
  db: TenantScopedPrisma,
  tenantId: string,
  from?: string,
  to?: string,
): Promise<StockReportContext> {
  const window = resolveDateWindow(from, to);
  const prior = priorWindow(window);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  const todayWindow: DateWindow = { from: todayStart, to: todayEnd };

  const metrics = await stockMetrics(
    db,
    tenantId,
    window,
    prior,
    todayStart,
    todayEnd,
  );

  return {
    window,
    prior,
    todayWindow,
    tenantId,
    metrics,
  };
}