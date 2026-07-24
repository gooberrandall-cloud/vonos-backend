import type {
  LedgerEntryType,
  LedgerListRow,
  LedgerSummary,
} from '@vonos/types';
import { AUTOS_GROUP_CODES } from '@vonos/types';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import {
  buildLedgerSummaryFromGroups,
  ledgerDateFilter,
} from '../../common/utils/ledgerAggregates';
import {
  EXCLUDE_INTERNAL_TRANSFER_SQL,
  isInternalTransferEntry,
} from '../../common/utils/internalTransfer';
import { toIso, toNumber } from '../../common/utils/serializers';
import { resolveDateWindow } from '../reports/aggregators/date-utils';
import {
  groupFinanceByTenantFromRollup,
  resolveGroupFinanceSource,
  sumDailyFinanceRollupForTenants,
} from '../../common/utils/dailyFinanceRollup';

async function nonVagTenants(prisma: PrismaClient) {
  return prisma.tenant.findMany({
    where: { code: { in: [...AUTOS_GROUP_CODES] }, deletedAt: null },
    select: { id: true, code: true, name: true },
  });
}

export async function buildGroupLedgerByEntity(
  prisma: PrismaClient,
  from?: string,
  to?: string,
): Promise<
  Array<{
    tenantId: string;
    tenantCode: string;
    tenantName: string;
    revenue: number;
    costs: number;
    net: number;
    outstanding: number;
    currency: string;
  }>
> {
  const tenants = await nonVagTenants(prisma);
  const window = resolveDateWindow(from, to);
  const tenantIds = tenants.map((t) => t.id);

  if (tenantIds.length === 0) return [];

  const useRollup = await resolveGroupFinanceSource(
    prisma,
    tenantIds,
    window.from,
    window.to,
  );

  if (useRollup) {
    const rollupRows = await groupFinanceByTenantFromRollup(
      prisma,
      tenantIds,
      window.from,
      window.to,
    );
    const byTenantId = new Map(rollupRows.map((row) => [row.tenantId, row]));
    return tenants
      .map((tenant) => {
        const row = byTenantId.get(tenant.id);
        const costs = (row?.costs ?? 0) + (row?.expenses ?? 0);
        return {
          tenantId: tenant.id,
          tenantCode: tenant.code,
          tenantName: tenant.name,
          revenue: row?.revenue ?? 0,
          costs,
          net: row?.net ?? 0,
          outstanding: 0,
          currency: 'NGN',
        };
      })
      .sort((a, b) => a.tenantCode.localeCompare(b.tenantCode));
  }

  const aggRows = await prisma.$queryRaw<
    Array<{
      tenantId: string;
      type: string;
      total: Prisma.Decimal | null;
    }>
  >`
    SELECT "tenantId", type, COALESCE(SUM(amount), 0) AS total
    FROM "LedgerEntry"
    WHERE "tenantId" IN (${Prisma.join(tenantIds)})
      AND "deletedAt" IS NULL
      AND date >= ${window.from}
      AND date <= ${window.to}
      ${EXCLUDE_INTERNAL_TRANSFER_SQL}
    GROUP BY "tenantId", type
  `;

  const byTenant = new Map(
    tenants.map((tenant) => [
      tenant.id,
      {
        tenantId: tenant.id,
        tenantCode: tenant.code,
        tenantName: tenant.name,
        revenue: 0,
        costs: 0,
        currency: 'NGN',
      },
    ]),
  );

  for (const row of aggRows) {
    const bucket = byTenant.get(row.tenantId);
    if (!bucket) continue;
    const amount = toNumber(row.total ?? 0);
    if (row.type === 'revenue') bucket.revenue += amount;
    else bucket.costs += amount;
  }

  return [...byTenant.values()]
    .map((row) => ({
      ...row,
      net: row.revenue - row.costs,
      outstanding: 0,
    }))
    .sort((a, b) => a.tenantCode.localeCompare(b.tenantCode));
}

export async function buildGroupLedgerSummary(
  prisma: PrismaClient,
  from?: string,
  to?: string,
): Promise<LedgerSummary> {
  const tenants = await nonVagTenants(prisma);
  const tenantIds = tenants.map((t) => t.id);
  const dateFilter = ledgerDateFilter(from, to);
  const window = resolveDateWindow(from, to);

  if (tenantIds.length === 0) {
    return buildLedgerSummaryFromGroups([], 'NGN');
  }

  const useRollup = await resolveGroupFinanceSource(
    prisma,
    tenantIds,
    window.from,
    window.to,
  );

  if (useRollup) {
    const totals = await sumDailyFinanceRollupForTenants(
      prisma,
      tenantIds,
      window.from,
      window.to,
    );
    return buildLedgerSummaryFromGroups(
      [
        {
          type: 'revenue' as LedgerEntryType,
          _sum: { amount: new Prisma.Decimal(totals.revenue) },
        },
        {
          type: 'cost' as LedgerEntryType,
          _sum: { amount: new Prisma.Decimal(totals.costs) },
        },
        {
          type: 'expense' as LedgerEntryType,
          _sum: { amount: new Prisma.Decimal(totals.expenses) },
        },
      ],
      'NGN',
    );
  }

  const [aggRows, currencyRow] = await Promise.all([
    prisma.$queryRaw<
      Array<{ type: string; total: Prisma.Decimal | null }>
    >`
      SELECT type, COALESCE(SUM(amount), 0) AS total
      FROM "LedgerEntry"
      WHERE "tenantId" IN (${Prisma.join(tenantIds)})
        AND "deletedAt" IS NULL
        AND date >= ${window.from}
        AND date <= ${window.to}
        ${EXCLUDE_INTERNAL_TRANSFER_SQL}
      GROUP BY type
    `,
    prisma.ledgerEntry.findFirst({
      where: {
        tenantId: { in: tenantIds },
        deletedAt: null,
        ...dateFilter,
      },
      select: { currency: true },
      orderBy: { date: 'desc' },
    }),
  ]);

  return buildLedgerSummaryFromGroups(
    aggRows.map((row) => ({
      type: row.type as LedgerEntryType,
      _sum: { amount: row.total },
    })),
    currencyRow?.currency ?? 'NGN',
  );
}

export async function buildGroupLedgerList(
  prisma: PrismaClient,
  filters: {
    type?: LedgerEntryType;
    category?: string;
    from?: string;
    to?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<LedgerListRow[]> {
  const tenants = await nonVagTenants(prisma);
  const tenantById = new Map(tenants.map((t) => [t.id, t]));
  const tenantIds = tenants.map((t) => t.id);

  const pagination = buildCompositeCursorQuery({
    sortField: 'date',
    sortDir: 'desc',
    cursor: filters.cursor,
    limit: filters.limit ?? 10,
    sortValueType: 'date',
  });
  const rows = await prisma.ledgerEntry.findMany({
    where: {
      tenantId: { in: tenantIds },
      deletedAt: null,
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.search
        ? {
            OR: [
              {
                description: {
                  contains: filters.search,
                  mode: 'insensitive',
                },
              },
              {
                category: {
                  contains: filters.search,
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
      ...(filters.from || filters.to
        ? {
            date: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {}),
      ...(pagination.where ?? {}),
    },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
    take: pagination.take,
  });

  return rows
    .filter(
      (row) =>
        !isInternalTransferEntry(
          row.category,
          row.description ?? '',
          row.isInternalTransfer,
        ),
    )
    .map((row) => {
      const tenant = tenantById.get(row.tenantId);
      return {
        id: row.id,
        tenantId: row.tenantId,
        type: row.type,
        amount: toNumber(row.amount),
        currency: row.currency,
        category: row.category,
        description: row.description,
        linkedRecordType: row.linkedRecordType,
        linkedRecordId: row.linkedRecordId,
        date: toIso(row.date),
        createdAt: toIso(row.createdAt),
        tenantCode: tenant?.code ?? null,
        tenantName: tenant?.name ?? null,
      };
    });
}

export async function buildGroupLedgerCategories(
  prisma: PrismaClient,
  from?: string,
  to?: string,
): Promise<string[]> {
  const tenants = await nonVagTenants(prisma);
  const tenantIds = tenants.map((t) => t.id);
  const dateFilter = ledgerDateFilter(from, to);
  const rows = await prisma.ledgerEntry.groupBy({
    by: ['category'],
    where: {
      tenantId: { in: tenantIds },
      deletedAt: null,
      ...dateFilter,
    },
    orderBy: { category: 'asc' },
  });
  return rows.map((row) => row.category);
}
