/**
 * Read-only: how August purchases relate to Payment rows vs stored status.
 *
 *   npx ts-node --transpile-only prisma/scripts/audit-purchase-payment-status.ts
 */
import { PrismaClient } from '@prisma/client';

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
    const moves = await prisma.stockMovement.findMany({
      where: {
        tenantId: t.id,
        deletedAt: null,
        type: 'inbound',
        date: { gte: CUTOFF },
      },
      select: {
        id: true,
        reference: true,
        paymentStatus: true,
        totalPaid: true,
        grandTotal: true,
      },
    });

    if (moves.length === 0) {
      console.log(`[${t.code}] no Aug purchases`);
      continue;
    }

    const byStatus: Record<string, number> = {};
    let withLinkedPay = 0;
    let paidButDueLabel = 0;
    let linkedSumGtStored = 0;
    const mismatches: Array<{
      ref: string;
      status: string | null;
      storedPaid: number;
      linkedPaid: number;
      grand: number;
      payCount: number;
    }> = [];

    for (const m of moves) {
      const st = m.paymentStatus ?? 'null';
      byStatus[st] = (byStatus[st] ?? 0) + 1;

      const inv = await prisma.invoice.findFirst({
        where: { stockMovementId: m.id, deletedAt: null },
        select: { id: true },
      });
      const pays = await prisma.payment.findMany({
        where: {
          tenantId: t.id,
          deletedAt: null,
          OR: [
            { paymentFor: 'purchase', paymentRefNo: m.reference },
            ...(inv ? [{ invoiceId: inv.id }] : []),
          ],
        },
        select: { amount: true },
      });
      const sum = pays.reduce((a, x) => a + Number(x.amount), 0);
      if (pays.length) withLinkedPay += 1;
      if (
        sum > 0.001 &&
        (m.paymentStatus === 'due' || m.paymentStatus == null)
      ) {
        paidButDueLabel += 1;
      }
      const stored = Number(m.totalPaid);
      if (Math.abs(sum - stored) > 0.01) {
        linkedSumGtStored += 1;
        if (mismatches.length < 8) {
          mismatches.push({
            ref: m.reference,
            status: m.paymentStatus,
            storedPaid: stored,
            linkedPaid: sum,
            grand: Number(m.grandTotal),
            payCount: pays.length,
          });
        }
      }
    }

    const purchasePays = await prisma.payment.count({
      where: {
        tenantId: t.id,
        deletedAt: null,
        paymentFor: 'purchase',
        OR: [
          { paidOn: { gte: CUTOFF } },
          { AND: [{ paidOn: null }, { createdAt: { gte: CUTOFF } }] },
        ],
      },
    });

    console.log(`[${t.code}] purchases=${moves.length}`);
    console.log(`  status counts:`, byStatus);
    console.log(
      `  withLinkedPayments=${withLinkedPay} paidButStillDueLabel=${paidButDueLabel} storedVsLinkedMismatch=${linkedSumGtStored} activePurchasePayments=${purchasePays}`,
    );
    if (mismatches.length) {
      console.log(`  mismatches:`, mismatches);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
