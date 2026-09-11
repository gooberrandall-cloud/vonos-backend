/**
 * Recompute StockMovement.totalPaid + paymentStatus from linked Payment rows.
 * Fixes list "Due" when payments exist but totalPaid was never cached.
 *
 *   npx ts-node --transpile-only prisma/scripts/resync-purchase-total-paid.ts
 *   npx ts-node --transpile-only prisma/scripts/resync-purchase-total-paid.ts --execute
 */
import { PrismaClient, type PurchasePaymentStatus } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--execute');
const onlyCode = (process.env.TENANT_CODE ?? '').trim().toUpperCase();
const OPERATING = [
  'VA',
  'VW',
  'VISP',
  'VSP',
  'VP',
  'VC',
  'VS',
  'VKW',
] as const;

function statusFromAmounts(
  total: number,
  paid: number,
  previous: string | null,
): PurchasePaymentStatus {
  if (paid <= 1e-6) {
    return previous === 'overdue' ? 'overdue' : 'due';
  }
  if (paid + 1e-6 < total) return 'partial';
  return 'paid';
}

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: {
      deletedAt: null,
      code: onlyCode ? onlyCode : { in: [...OPERATING] },
    },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });

  console.log(
    dryRun
      ? 'DRY-RUN — pass --execute to apply'
      : 'EXECUTE — resyncing purchase totalPaid/paymentStatus',
  );

  let wouldFix = 0;
  let fixed = 0;

  for (const tenant of tenants) {
    const moves = await prisma.stockMovement.findMany({
      where: { tenantId: tenant.id, deletedAt: null, type: 'inbound' },
      select: {
        id: true,
        reference: true,
        paymentStatus: true,
        totalPaid: true,
        grandTotal: true,
      },
    });

    let tenantFixes = 0;
    for (const m of moves) {
      const inv = await prisma.invoice.findFirst({
        where: { stockMovementId: m.id, deletedAt: null },
        select: { id: true },
      });
      const agg = await prisma.payment.aggregate({
        where: {
          tenantId: tenant.id,
          deletedAt: null,
          OR: [
            {
              paymentFor: { equals: 'purchase', mode: 'insensitive' },
              paymentRefNo: { equals: m.reference, mode: 'insensitive' },
            },
            {
              paymentRefNo: { equals: m.reference, mode: 'insensitive' },
              paymentFor: null,
            },
            ...(inv ? [{ invoiceId: inv.id }] : []),
            {
              note: { contains: m.reference, mode: 'insensitive' },
              OR: [
                { paymentFor: { equals: 'purchase', mode: 'insensitive' } },
                { paymentFor: null },
              ],
            },
          ],
        },
        _sum: { amount: true },
      });
      const paid = Number(agg._sum.amount ?? 0);
      const stored = Number(m.totalPaid);
      const total = Number(m.grandTotal);
      const nextStatus = statusFromAmounts(total, paid, m.paymentStatus);
      const needs =
        Math.abs(paid - stored) > 0.01 || m.paymentStatus !== nextStatus;
      if (!needs) continue;
      tenantFixes += 1;
      wouldFix += 1;
      if (dryRun) continue;
      await prisma.stockMovement.update({
        where: { id: m.id },
        data: { totalPaid: paid, paymentStatus: nextStatus },
      });
      fixed += 1;
    }
    console.log(
      `[${tenant.code}] purchases=${moves.length} toFix=${tenantFixes}`,
    );
  }

  console.log(
    dryRun
      ? `Dry-run complete. Would fix ${wouldFix} purchase(s).`
      : `Execute complete. Fixed ${fixed} purchase(s).`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
