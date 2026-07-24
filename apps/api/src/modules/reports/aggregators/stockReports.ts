import type { ReportsDashboard } from '@vonos/types';
import type { TenantScopedPrisma } from '../../../common/prisma/prisma.service';
import { asChartData, computeDelta } from './date-utils';
import type { StockReportContext } from './stockReportContext';
import { loadStockReportContext } from './stockReportContext';
import {
  lowStockByCategory,
  lowStockItems,
  stockMovementTrend,
  stockValueByCategory,
  topStockValueItems,
  type StockItemRow,
} from './stockReportQueries';

type StockTab = 'valuation' | 'movement' | 'lowstock';

export async function buildStockReportsFromContext(
  ctx: StockReportContext,
  db: TenantScopedPrisma,
  tab: StockTab,
): Promise<ReportsDashboard> {
  const { window, metrics, tenantId } = ctx;
  const {
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
  } = metrics;

  if (tab === 'valuation') {
    const [chartData, valueItems] = await Promise.all([
      stockValueByCategory(db, tenantId),
      topStockValueItems(db, tenantId),
    ]);

    const tableRows = valueItems.map((item: StockItemRow) => {
      const stockValue = Math.round(item.quantity * item.costPrice * 100) / 100;
      return {
        id: item.id,
        recordType: 'item',
        sku: item.sku,
        name: item.name,
        category: item.category ?? '—',
        quantity: item.quantity,
        costPrice: Math.round(item.costPrice * 100) / 100,
        stockValue,
        currency: item.currency,
      };
    });

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
          data: asChartData(chartData),
        },
      ],
      table: {
        columns: [
          { key: 'sku', header: 'SKU' },
          { key: 'name', header: 'Name' },
          { key: 'category', header: 'Category' },
          { key: 'quantity', header: 'Qty' },
          { key: 'costPrice', header: 'Unit Cost' },
          { key: 'stockValue', header: 'Stock Value' },
        ],
        rows: tableRows,
        columnTotals: {
          quantity: totalUnits,
          stockValue: Math.round(stockValue * 100) / 100,
        },
      },
    };
  }

  if (tab === 'movement') {
    const chartData = await stockMovementTrend(db, tenantId, window);

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
          data: asChartData(chartData),
        },
      ],
      table: null,
    };
  }

  const [pieData, lowItems] = await Promise.all([
    lowStockByCategory(db, tenantId),
    lowStockItems(db, tenantId),
  ]);

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
        data: pieData.length > 0 ? asChartData(pieData) : asChartData([{ label: 'None', value: 0 }]),
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
      rows: lowItems.map((item: StockItemRow) => ({
        id: item.id,
        recordType: 'item',
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        reorderPoint: item.reorderPoint ?? '—',
        status: item.status.replace('_', ' '),
      })),
      columnTotals: {
        quantity: lowItems.reduce((s, item) => s + item.quantity, 0),
      },
    },
  };
}

export async function buildStockReports(
  db: TenantScopedPrisma,
  tenantId: string,
  tab: StockTab,
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const ctx = await loadStockReportContext(db, tenantId, from, to);
  return buildStockReportsFromContext(ctx, db, tab);
}
