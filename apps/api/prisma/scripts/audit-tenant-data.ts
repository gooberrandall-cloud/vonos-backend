/**
 * Count active tenant-scoped records (dry audit).
 * Usage: TENANT_CODES=VS,VKW npx ts-node --transpile-only prisma/scripts/audit-tenant-data.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const codes = (process.env.TENANT_CODES ?? 'VS,VKW')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

async function count(
  label: string,
  fn: (tenantId: string) => Promise<number>,
  tenantId: string,
): Promise<[string, number]> {
  return [label, await fn(tenantId)];
}

async function main() {
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null, code: { in: codes } },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });

  for (const tenant of tenants) {
    const tid = tenant.id;
    const rows = await Promise.all([
      count('item', (id) => prisma.item.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('sale', (id) => prisma.sale.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('stockMovement', (id) => prisma.stockMovement.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('expense', (id) => prisma.expense.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('payment', (id) => prisma.payment.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('ledgerEntry', (id) => prisma.ledgerEntry.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('accountTransaction', (id) => prisma.accountTransaction.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('invoice', (id) => prisma.invoice.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('job', (id) => prisma.job.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('appointment', (id) => prisma.appointment.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('customer', (id) => prisma.customer.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('supplier', (id) => prisma.supplier.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('vehicle', (id) => prisma.vehicle.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('requisition', (id) => prisma.requisition.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('salonService', (id) => prisma.salonService.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('productCategory', (id) => prisma.productCategory.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('brand', (id) => prisma.brand.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('productUnit', (id) => prisma.productUnit.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('customerGroup', (id) => prisma.customerGroup.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('expenseCategory', (id) => prisma.expenseCategory.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('paymentAccount', (id) => prisma.paymentAccount.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('employee', (id) => prisma.employee.count({ where: { tenantId: id, deletedAt: null } }), tid),
      count('notification', (id) => prisma.notification.count({ where: { tenantId: id } }), tid),
    ]);

    console.log(`\n[${tenant.code}] ${tenant.name}`);
    for (const [label, n] of rows) {
      if (n > 0) console.log(`  ${label}: ${n}`);
    }
    const total = rows.reduce((s, [, n]) => s + n, 0);
    console.log(`  --- total active: ${total}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
