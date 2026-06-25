import type { LedgerEntryType, LedgerSummary } from '@vonos/types';
import type { Prisma } from '@prisma/client';
import { toNumber } from './serializers';

type LedgerGroupRow = {
  type: LedgerEntryType;
  _sum: { amount: Prisma.Decimal | null };
};

export function buildLedgerSummaryFromGroups(
  groups: LedgerGroupRow[],
  currency = 'NGN',
): LedgerSummary {
  let revenue = 0;
  let costs = 0;

  for (const group of groups) {
    const amount = toNumber(group._sum.amount ?? 0);
    if (group.type === 'revenue') revenue += amount;
    else costs += amount;
  }

  return {
    revenue,
    costs,
    net: revenue - costs,
    outstanding: 0,
    currency,
  };
}

export function ledgerDateFilter(
  from?: string,
  to?: string,
): { date?: { gte?: Date; lte?: Date } } {
  if (!from && !to) return {};
  return {
    date: {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    },
  };
}
