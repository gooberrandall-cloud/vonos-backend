/**
 * Read-only: pre-August payments vs account-book movements vs balances.
 *
 *   npx ts-node --transpile-only prisma/scripts/audit-pre-aug-account-balances.ts
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const CUTOFF = new Date('2026-08-01T00:00:00+01:00');
const CODES = ['VA', 'VISP', 'VSP', 'VP', 'VC', 'VW'] as const;

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null, code: { in: [...CODES] } },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });

  for (const t of tenants) {
    const prePay = await prisma.payment.count({
      where: {
        tenantId: t.id,
        deletedAt: null,
        OR: [
          { paidOn: { lt: CUTOFF } },
          { AND: [{ paidOn: null }, { createdAt: { lt: CUTOFF } }] },
        ],
      },
    });
    const augPay = await prisma.payment.count({
      where: {
        tenantId: t.id,
        deletedAt: null,
        OR: [
          { paidOn: { gte: CUTOFF } },
          { AND: [{ paidOn: null }, { createdAt: { gte: CUTOFF } }] },
        ],
      },
    });
    const softPay = await prisma.payment.count({
      where: { tenantId: t.id, deletedAt: { not: null } },
    });

    const preTxns = await prisma.accountTransaction.groupBy({
      by: ['type'],
      where: {
        tenantId: t.id,
        deletedAt: null,
        operationDate: { lt: CUTOFF },
      },
      _sum: { amount: true },
      _count: true,
    });
    const augTxns = await prisma.accountTransaction.groupBy({
      by: ['type'],
      where: {
        tenantId: t.id,
        deletedAt: null,
        operationDate: { gte: CUTOFF },
      },
      _sum: { amount: true },
      _count: true,
    });

    let preN = 0;
    let preDebit = 0;
    let preCredit = 0;
    for (const r of preTxns) {
      preN += r._count;
      if (r.type === 'debit') preDebit += Number(r._sum.amount ?? 0);
      else preCredit += Number(r._sum.amount ?? 0);
    }
    let augN = 0;
    let augDebit = 0;
    let augCredit = 0;
    for (const r of augTxns) {
      augN += r._count;
      if (r.type === 'debit') augDebit += Number(r._sum.amount ?? 0);
      else augCredit += Number(r._sum.amount ?? 0);
    }

    const balRows = await prisma.$queryRaw<
      Array<{
        name: string;
        balance: number;
        pre_n: number;
        aug_n: number;
        pre_effect: number;
        aug_effect: number;
      }>
    >(Prisma.sql`
      SELECT a.name,
        COALESCE(SUM(
          CASE WHEN x.type = 'credit' THEN x.amount ELSE -x.amount END
        ), 0)::float AS balance,
        COUNT(*) FILTER (WHERE x."operationDate" < ${CUTOFF})::int AS pre_n,
        COUNT(*) FILTER (WHERE x."operationDate" >= ${CUTOFF})::int AS aug_n,
        COALESCE(SUM(
          CASE
            WHEN x."operationDate" < ${CUTOFF} AND x.type = 'credit' THEN x.amount
            WHEN x."operationDate" < ${CUTOFF} THEN -x.amount
            ELSE 0
          END
        ), 0)::float AS pre_effect,
        COALESCE(SUM(
          CASE
            WHEN x."operationDate" >= ${CUTOFF} AND x.type = 'credit' THEN x.amount
            WHEN x."operationDate" >= ${CUTOFF} THEN -x.amount
            ELSE 0
          END
        ), 0)::float AS aug_effect
      FROM "PaymentAccount" a
      LEFT JOIN "AccountTransaction" x
        ON x."accountId" = a.id AND x."deletedAt" IS NULL
      WHERE a."tenantId" = ${t.id}
        AND a."deletedAt" IS NULL
        AND a."isClosed" = false
      GROUP BY a.id, a.name
      ORDER BY balance ASC
      LIMIT 8
    `);

    const bySub = await prisma.accountTransaction.groupBy({
      by: ['subType', 'type'],
      where: {
        tenantId: t.id,
        deletedAt: null,
        operationDate: { lt: CUTOFF },
      },
      _sum: { amount: true },
      _count: true,
    });

    console.log(`[${t.code}]`);
    console.log(
      `  payments active: pre-Aug=${prePay} Aug+=${augPay} soft-deleted=${softPay}`,
    );
    console.log(
      `  account txns: pre=${preN} (credit=${preCredit.toFixed(0)} debit=${preDebit.toFixed(0)}) | Aug+=${augN} (credit=${augCredit.toFixed(0)} debit=${augDebit.toFixed(0)})`,
    );
    console.log(
      `  pre-Aug by subtype:`,
      bySub
        .map(
          (r) =>
            `${r.subType ?? 'null'}/${r.type}=${r._count}@${Number(r._sum.amount ?? 0).toFixed(0)}`,
        )
        .slice(0, 12),
    );
    console.log(
      `  accounts (lowest balances first):`,
      balRows.map((r) => ({
        name: r.name,
        balance: Math.round(r.balance),
        pre_n: r.pre_n,
        pre_effect: Math.round(r.pre_effect),
        aug_n: r.aug_n,
        aug_effect: Math.round(r.aug_effect),
      })),
    );
  }

  const orphans = await prisma.$queryRaw<
    Array<{ code: string; n: number; debit: number; credit: number }>
  >(Prisma.sql`
    SELECT t.code,
      COUNT(*)::int AS n,
      COALESCE(SUM(CASE WHEN x.type = 'debit' THEN x.amount ELSE 0 END), 0)::float AS debit,
      COALESCE(SUM(CASE WHEN x.type = 'credit' THEN x.amount ELSE 0 END), 0)::float AS credit
    FROM "AccountTransaction" x
    JOIN "Tenant" t ON t.id = x."tenantId"
    JOIN "Payment" p ON p.id = x."paymentId"
    WHERE x."deletedAt" IS NULL
      AND p."deletedAt" IS NOT NULL
    GROUP BY t.code
    ORDER BY t.code
  `);
  console.log('\nOrphans (active account txn → soft-deleted payment):', orphans);

  const preOrphans = await prisma.$queryRaw<
    Array<{ code: string; n: number }>
  >(Prisma.sql`
    SELECT t.code, COUNT(*)::int AS n
    FROM "AccountTransaction" x
    JOIN "Tenant" t ON t.id = x."tenantId"
    WHERE x."deletedAt" IS NULL
      AND x."operationDate" < ${CUTOFF}
    GROUP BY t.code
    ORDER BY t.code
  `);
  console.log('Pre-Aug active account txns by tenant:', preOrphans);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
