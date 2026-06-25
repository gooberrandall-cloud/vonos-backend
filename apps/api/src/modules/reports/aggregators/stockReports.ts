import type { ReportsDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { buildTimeSeries, computeDelta } from './date-utils';
import type { StockReportContext } from './stockReportContext';
import { loadStockReportContext } from './stockReportContext';

type StockTab = 'valuation' | 'movement' | 'lowstock';

export function buildStockReportsFromContext(
  ctx: StockReportContext,
  tab: StockTab,
): ReportsDashboard {
  const {
    window,
    items,
    periodMovements,
    stockValue,
    totalSku,
    totalUnits,
    lowStockCount,
    outOfStockCount,
    todayInbound,
    todayOutbound,
    movementCount,
    priorMovementCount,
    velocity,
    priorVelocity,
    currency,
  } = ctx;

  if (tab === 'valuation') {
    const byCategory = new Map<string, number>();
    for (const item of items) {
      const cat = item.category ?? 'Uncategorized';
      const value = item.quantity * item.costPrice;
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + value);
    }
    const chartData = Array.from(byCategory.entries())
      .map(([label, value]) => ({ label, value: Math.round(value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12);

    return {
      kpis: [
        {
          label: 'Stock Value',
          icon: 'calculator',
          metricKey: 'stockValue',
          color: '#e11d48',
          value: stockValue,
          currency,
        },
        {
          label: 'Total SKU',
          icon: 'package',
          metricKey: 'totalSku',
          color: '#059669',
          value: totalSku,
        },
        {
          label: 'Total Units',
          icon: 'package',
          metricKey: 'totalUnits',
          color: '#2563eb',
          value: totalUnits,
        },
        {
          label: 'Low Stock SKUs',
          icon: 'alert-triangle',
          metricKey: 'lowStockCount',
          color: '#9333ea',
          value: lowStockCount,
        },
      ],
      charts: [
        {
          id: 'value-by-category',
          title: 'Inventory Value by Category',
          subtitle: 'Current on-hand valuation',
          type: 'bar',
          horizontal: true,
          series: [{ name: 'Value', dataKey: 'value', color: '#10b981' }],
          data: chartData,
        },
      ],
      table: null,
    };
  }

  if (tab === 'movement') {
    const inbound = periodMovements.filter(
      (m) =>
        m.type === 'inbound' && m.date >= window.from && m.date <= window.to,
    );
    const outbound = periodMovements.filter(
      (m) =>
        m.type === 'outbound' && m.date >= window.from && m.date <= window.to,
    );
    const inboundSeries = buildTimeSeries(inbound, window, () => 1);
    const outboundSeries = buildTimeSeries(outbound, window, () => 1);
    const keys = new Set([
      ...inboundSeries.map((r) => r.label),
      ...outboundSeries.map((r) => r.label),
    ]);
    const inboundMap = new Map(inboundSeries.map((r) => [r.label, r.value]));
    const outboundMap = new Map(outboundSeries.map((r) => [r.label, r.value]));
    const chartData = Array.from(keys)
      .sort()
      .map((label) => ({
        label,
        inbound: inboundMap.get(label) ?? 0,
        outbound: outboundMap.get(label) ?? 0,
      }));

    return {
      kpis: [
        {
          label: 'Today Inbound',
          icon: 'arrow-down',
          metricKey: 'todayInbound',
          color: '#2563eb',
          value: todayInbound,
        },
        {
          label: 'Today Outbound',
          icon: 'arrow-up',
          metricKey: 'todayOutbound',
          color: '#9333ea',
          value: todayOutbound,
        },
        {
          label: 'Movements',
          icon: 'arrow-right-left',
          metricKey: 'movementCount',
          color: '#059669',
          value: movementCount,
          ...computeDelta(movementCount, priorMovementCount),
        },
        {
          label: 'Movement Velocity',
          icon: 'trending-up',
          metricKey: 'velocity',
          color: '#e11d48',
          value: velocity,
          ...computeDelta(velocity, priorVelocity),
        },
      ],
      charts: [
        {
          id: 'inbound-outbound',
          title: 'Inbound vs Outbound',
          subtitle: 'Movement volume over selected period',
          type: 'bar',
          series: [
            { name: 'Inbound', dataKey: 'inbound', color: '#3b82f6' },
            { name: 'Outbound', dataKey: 'outbound', color: '#93c5fd' },
          ],
          data: chartData,
        },
      ],
      table: null,
    };
  }

  // lowstock
  const lowItems = items
    .filter(
      (item) =>
        item.status === 'low_stock' ||
        item.status === 'out_of_stock' ||
        (item.reorderPoint != null && item.quantity <= item.reorderPoint),
    )
    .sort((a, b) => a.quantity - b.quantity);

  const byCategoryLow = new Map<string, number>();
  for (const item of lowItems) {
    const cat = item.category ?? 'Uncategorized';
    byCategoryLow.set(cat, (byCategoryLow.get(cat) ?? 0) + 1);
  }
  const pieData = Array.from(byCategoryLow.entries()).map(([label, value]) => ({
    label,
    value,
  }));

  return {
    kpis: [
      {
        label: 'Low Stock SKUs',
        icon: 'alert-triangle',
        metricKey: 'lowStockCount',
        color: '#9333ea',
        value: lowStockCount,
      },
      {
        label: 'Out of Stock',
        icon: 'package',
        metricKey: 'outOfStockCount',
        color: '#e11d48',
        value: outOfStockCount,
      },
      {
        label: 'Total SKU',
        icon: 'package',
        metricKey: 'totalSku',
        color: '#059669',
        value: totalSku,
      },
      {
        label: 'Stock Value',
        icon: 'calculator',
        metricKey: 'stockValue',
        color: '#2563eb',
        value: stockValue,
        currency,
      },
    ],
    charts: [
      {
        id: 'low-by-category',
        title: 'Low Stock by Category',
        subtitle: 'SKUs at or below reorder point',
        type: 'pie',
        series: [{ name: 'SKUs', dataKey: 'value', color: '#f59e0b' }],
        data: pieData.length > 0 ? pieData : [{ label: 'None', value: 0 }],
      },
    ],
    table: {
      columns: [
        { key: 'sku', header: 'SKU' },
        { key: 'name', header: 'Name' },
        { key: 'quantity', header: 'Qty' },
        { key: 'reorderPoint', header: 'Reorder' },
        { key: 'status', header: 'Status' },
      ],
      rows: lowItems.slice(0, 50).map((item) => ({
        id: item.id,
        recordType: 'item',
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        reorderPoint: item.reorderPoint ?? '—',
        status: item.status.replace('_', ' '),
      })),
    },
  };
}

export async function buildStockReports(
  db: TenantScopedPrisma,
  tab: StockTab,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const ctx = await loadStockReportContext(db, from, to);
  return buildStockReportsFromContext(ctx, tab);
}
