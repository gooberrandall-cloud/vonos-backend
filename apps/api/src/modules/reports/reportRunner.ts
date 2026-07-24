import type { ReportsDashboard, ReportRunOptions } from '@vonos/types';
import { AUTOS_GROUP_CODES, reportEntryById } from '@vonos/types';
import type { PrismaClient } from '@prisma/client';
import type { TenantDbService } from '../../common/prisma/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { buildStockReports } from './aggregators/stockReports';
import { buildTransactionReports } from './aggregators/transactionReports';
import {
  buildContactsSummaryReport,
  buildCustomerGroupsReport,
  buildPurchasePaymentReport,
  buildPurchaseSaleReport,
  buildRegisterReport,
  buildSalesRepReport,
  buildServiceStaffReport,
  buildStockDetailsReport,
  buildStockExpiryReport,
  buildTaxReport,
  buildTrendingProductsReport,
} from './aggregators/transactionReportHandlers';
import {
  buildItemsReport,
  buildProductPurchaseReport,
  buildProductSellReport,
  buildSellPaymentReport,
} from './aggregators/tableReportHandlers';
import { buildGroupReports } from './aggregators/groupReports';
import {
  buildEntityRollupForReport,
  dashboardFromGroupRollup,
} from './aggregators/groupReportRollups';
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
  options?: ReportRunOptions,
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
        ? buildProfitLossReport(db, tenantId, from, to)
        : buildExpenseReport(db, from, to, options);
    case 'payment-accounts': {
      const handler = source.handler;
      if (handler === 'balance-sheet')
        return buildBalanceSheetReport(db, from, to);
      if (handler === 'trial-balance')
        return buildTrialBalanceReport(db, from, to);
      if (handler === 'cash-flow') return buildCashFlowReport(db, from, to);
      return buildPaymentAccountReport(db, from, to, options);
    }
    case 'reports':
      if (archetype === 'stock') {
        return buildStockReports(
          db,
          tenantId,
          source.tab as 'valuation' | 'movement' | 'lowstock',
          from,
          to,
        );
      }
      return buildTransactionReports(
        db,
        tenantId,
        source.tab as 'sales' | 'closeout',
        from,
        to,
      );
    case 'stock':
      if (source.handler === 'expiry') {
        return buildStockExpiryReport(db, tenantId);
      }
      if (source.handler === 'details') {
        return buildStockDetailsReport(db);
      }
      return buildStockReports(
        db,
        tenantId,
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
        return buildTrendingProductsReport(db, tenantId, from, to);
      if (handler === 'items')
        return buildItemsReport(db, tenantId, from, to, options);
      if (handler === 'purchase')
        return buildProductPurchaseReport(db, tenantId, from, to, options);
      return buildProductSellReport(db, tenantId, from, to, options);
    }
    case 'sales': {
      const handler = source.handler;
      if (handler === 'purchase-sale')
        return buildPurchaseSaleReport(db, tenantId, from, to, options);
      if (handler === 'tax')
        return buildTaxReport(db, tenantId, from, to, options);
      if (handler === 'register')
        return buildRegisterReport(db, tenantId, from, to);
      if (handler === 'service-staff') {
        return buildServiceStaffReport(db, tenantId, from, to);
      }
      return buildSalesRepReport(db, tenantId, from, to);
    }
    case 'payments':
      return source.handler === 'purchase'
        ? buildPurchasePaymentReport(db, from, to, options)
        : buildSellPaymentReport(db, tenantId, from, to, options);
    case 'contacts':
      return source.handler === 'customer-groups'
        ? buildCustomerGroupsReport(db, tenantId, from, to, options)
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
    where: { code: { in: [...AUTOS_GROUP_CODES] }, deletedAt: null },
    select: { id: true, code: true, archetype: true },
    orderBy: { code: 'asc' },
  });

  const byEntity = await buildEntityRollupForReport(
    prisma,
    entry,
    tenants,
    from,
    to,
  );

  return dashboardFromGroupRollup(entry, byEntity);
}
