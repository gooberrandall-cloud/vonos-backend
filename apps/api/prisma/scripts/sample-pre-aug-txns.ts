/**
 * Sample pre-Aug account txns + Aug debit/credit mix for VA/VISP.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CUTOFF = new Date('2026-08-01T00:00:00+01:00');

async function sample(code: string) {
  const t = await prisma.tenant.findFirst({
    where: { code, deletedAt: null },
    select: { id: true },
  });
  if (!t) return;

  const pre = await prisma.accountTransaction.findMany({
    where: { tenantId: t.id, deletedAt: null, operationDate: { lt: CUTOFF } },
    select: {
      type: true,
      subType: true,
      amount: true,
      note: true,
      refNo: true,
      paymentId: true,
      expenseId: true,
      saleId: true,
      operationDate: true,
    },
    orderBy: { amount: 'desc' },
    take: 8,
  });

  const augBySub = await prisma.accountTransaction.groupBy({
    by: ['subType', 'type'],
    where: {
      tenantId: t.id,
      deletedAt: null,
      operationDate: { gte: CUTOFF },
    },
    _sum: { amount: true },
    _count: true,
  });

  console.log(`[${code}] pre-Aug samples:`, pre);
  console.log(
    `[${code}] Aug by subtype:`,
    augBySub.map((r) => ({
      sub: r.subType,
      type: r.type,
      n: r._count,
      sum: Number(r._sum.amount ?? 0),
    })),
  );
}

async function main() {
  await sample('VA');
  await sample('VISP');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
