import type { ReportsDashboard } from '@vonos/types';
import { reportEntryById } from '@vonos/types';
import type { PrismaClient } from '@prisma/client';
import type { TenantDbService } from '../../common/prisma/tenant-db.service';
import { ledgerDateFilter } from '../../common/utils/ledgerAggregates';
import { toNumber } from '../../common/utils/serializers';
import { AuditService } from '../audit/audit.service';
import { buildStockReports } from './aggregators/stockReports';
import { buildTransactionReports } from './aggregators/transactionReports';
import {
  buildContactsSummaryReport,
  buildCustomerGroupsReport,
  buildItemsReport,
  buildProductPurchaseReport,
  buildProductSellReport,
  buildPurchasePaymentReport,
  buildPurchaseSaleReport,
  buildRegisterReport,
  buildSalesRepReport,
  buildSellPaymentReport,
  buildStockExpiryReport,
  buildTaxReport,
  buildTrendingProductsReport,
} from './aggregators/transactionReportHandlers';
import { buildGroupReports } from './aggregators/groupReports';
import {
  buildExpenseReport,
  buildProfitLossReport,
} from './aggregators/financeReportHandlers';
import {
  buildBalanceSheetReport,
  buildCashFlowReport,
  buildPaymentAccountReport,
  buildTrialBalanceReport,
} from './aggregators/paymentAccountReportHandlers';

type ScopedDb = TenantDbService['db'];

export async function runReportForTenant(
  reportId: string,
  deps: {
    db: ScopedDb;
    prisma: PrismaClient;
    tenantId: string;
    archetype: string;
    auditService?: AuditService;
  },
  from?: string,
  to?: string,
): Promise<ReportsDashboard> {
  const entry = reportEntryById(reportId);
  if (!entry) {
    throw new Error(`Unknown report: ${reportId}`);
  }

  const { db, prisma, tenantId, archetype } = deps;
  const source = entry.source;

  switch (source.kind) {
    case 'ledger':
      return source.handler === 'pl'
        ? buildProfitLossReport(db, from, to)
        : buildExpenseReport(db, from, to);
    case 'payment-accounts': {
      const handler = source.handler;
      if (handler === 'balance-sheet')
        return buildBalanceSheetReport(db, from, to);
      if (handler === 'trial-balance')
        return buildTrialBalanceReport(db, from, to);
      if (handler === 'cash-flow') return buildCashFlowReport(db, from, to);
      return buildPaymentAccountReport(db, from, to);
    }
    case 'reports':
      if (archetype === 'stock') {
        return buildStockReports(
          db,
          source.tab as 'valuation' | 'movement' | 'lowstock',
          from,
          to,
        );
      }
      return buildTransactionReports(
        db,
        source.tab as 'sales' | 'closeout',
        from,
        to,
      );
    case 'stock':
      if (source.handler === 'expiry') {
        return buildStockExpiryReport(db);
      }
      return buildStockReports(
        db,
        source.handler === 'lowstock'
          ? 'lowstock'
          : source.handler === 'movement'
            ? 'movement'
            : 'valuation',
        from,
        to,
      );
    case 'product': {
      const handler = source.handler;
      if (handler === 'trending')
        return buildTrendingProductsReport(db, from, to);
      if (handler === 'items') return buildItemsReport(db, from, to);
      if (handler === 'purchase')
        return buildProductPurchaseReport(db, from, to);
      return buildProductSellReport(db, from, to);
    }
    case 'sales': {
      const handler = source.handler;
      if (handler === 'purchase-sale')
        return buildPurchaseSaleReport(db, from, to);
      if (handler === 'tax') return buildTaxReport(db, from, to);
      if (handler === 'register') return buildRegisterReport(db, from, to);
      return buildSalesRepReport(db, from, to);
    }
    case 'payments':
      return source.handler === 'purchase'
        ? buildPurchasePaymentReport(db, from, to)
        : buildSellPaymentReport(db, from, to);
    case 'contacts':
      return source.handler === 'customer-groups'
        ? buildCustomerGroupsReport(db, from, to)
        : buildContactsSummaryReport(db, from, to);
    case 'audit': {
      const logs = await prisma.auditLog.findMany({
        where: {
          tenantId,
          ...(from || to
            ? {
                occurredAt: {
                  ...(from ? { gte: new Date(from) } : {}),
                  ...(to ? { lte: new Date(to) } : {}),
                },
              }
            : {}),
        },
        orderBy: { occurredAt: 'desc' },
        take: 200,
      });
      return {
        kpis: [
          {
            label: 'Log entries',
            icon: 'activity',
            metricKey: 'logs',
            color: '#2563eb',
            value: logs.length,
          },
        ],
        charts: [],
        table: {
          columns: [
            { key: 'occurredAt', header: 'When' },
            { key: 'actorName', header: 'User' },
            { key: 'summary', header: 'Summary' },
          ],
          rows: logs.map((log) => ({
            occurredAt: log.occurredAt.toISOString(),
            actorName: log.actorName ?? '—',
            summary: log.summary,
          })),
        },
      };
    }
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

export async function runGroupReport(
  prisma: PrismaClient,
  reportId: string,
  from?: string,
  to?: string,
): Promise<
  ReportsDashboard & {
    byEntity?: Array<{ code: string; rows: Record<string, string | number>[] }>;
  }
> {
  const entry = reportEntryById(reportId);
  if (!entry?.groupRollup) {
    return buildGroupReports(prisma, from, to);
  }

  const tenants = await prisma.tenant.findMany({
    where: { code: { not: 'VAG' }, deletedAt: null },
    select: { id: true, code: true, archetype: true },
    orderBy: { code: 'asc' },
  });

  const dateFilter = ledgerDateFilter(from, to);
  const byEntity: Array<{
    code: string;
    rows: Record<string, string | number>[];
  }> = [];

  if (entry.source.kind === 'ledger') {
    for (const tenant of tenants) {
      const groups = await prisma.ledgerEntry.groupBy({
        by: ['type'],
        where: { tenantId: tenant.id, deletedAt: null, ...dateFilter },
        _sum: { amount: true },
      });
      const revenue = groups
        .filter((g) => g.type === 'revenue')
        .reduce((s, g) => s + toNumber(g._sum.amount ?? 0), 0);
      const costs = groups
        .filter((g) => g.type !== 'revenue')
        .reduce((s, g) => s + toNumber(g._sum.amount ?? 0), 0);
      byEntity.push({
        code: tenant.code,
        rows: [{ revenue, costs, net: revenue - costs }],
      });
    }
  }

  const groupDashboard = await buildGroupReports(prisma, from, to);
  return { ...groupDashboard, byEntity };
}
