import type {
  LedgerEntryType,
  LedgerListRow,
  LedgerSummary,
} from '@vonos/types';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { buildCursorQuery } from '../../common/utils/pagination';
import {
  buildLedgerSummaryFromGroups,
  ledgerDateFilter,
} from '../../common/utils/ledgerAggregates';
import { toIso, toNumber } from '../../common/utils/serializers';

/** Categories/descriptions for internal Warehouse ↔ entity stock moves — excluded from group P&L roll-up. */
const INTERNAL_TRANSFER_MARKERS = [
  'internal transfer',
  'stock transfer',
  'requisition fulfillment',
  'inter-entity transfer',
];

function isInternalTransferEntry(
  category: string,
  description: string,
): boolean {
  const haystack = `${category} ${description}`.toLowerCase();
  return INTERNAL_TRANSFER_MARKERS.some((marker) => haystack.includes(marker));
}

function applyTransferElimination<
  T extends {
    category: string;
    description: string;
    type: string;
    amount: number;
  },
>(rows: T[]): T[] {
  return rows.filter(
    (row) => !isInternalTransferEntry(row.category, row.description),
  );
}

async function nonVagTenants(prisma: PrismaClient) {
  return prisma.tenant.findMany({
    where: { code: { not: 'VAG' }, deletedAt: null },
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

  const dateFilter = ledgerDateFilter(from, to);
  const tenantIds = tenants.map((t) => t.id);

  const ledgerRows = await prisma.ledgerEntry.findMany({
    where: {
      tenantId: { in: tenantIds },
      deletedAt: null,
      ...dateFilter,
    },
    select: {
      tenantId: true,
      type: true,
      category: true,
      description: true,
      amount: true,
    },
  });

  const filtered = applyTransferElimination(
    ledgerRows.map((row) => ({
      tenantId: row.tenantId,
      type: row.type,
      category: row.category,
      description: row.description,
      amount: toNumber(row.amount),
    })),
  );

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

  for (const row of filtered) {
    const bucket = byTenant.get(row.tenantId);
    if (!bucket) continue;
    if (row.type === 'revenue') bucket.revenue += row.amount;
    else bucket.costs += row.amount;
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

  const [ledgerRows, currencyRow] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: {
        tenantId: { in: tenantIds },
        deletedAt: null,
        ...dateFilter,
      },
      select: {
        type: true,
        category: true,
        description: true,
        amount: true,
      },
    }),
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

  const filtered = applyTransferElimination(
    ledgerRows.map((row) => ({
      type: row.type,
      category: row.category,
      description: row.description,
      amount: toNumber(row.amount),
    })),
  );

  const grouped = new Map<LedgerEntryType, number>();
  for (const row of filtered) {
    const current = grouped.get(row.type) ?? 0;
    grouped.set(row.type, current + row.amount);
  }

  return buildLedgerSummaryFromGroups(
    [...grouped.entries()].map(([type, amount]) => ({
      type,
      _sum: { amount: new Prisma.Decimal(amount) },
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
    },
    orderBy: { date: 'desc' },
    ...buildCursorQuery(filters.cursor, filters.limit ?? 50),
  });

  return rows.map((row) => {
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
