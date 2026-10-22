import type { PrismaClient } from '@prisma/client';

const DEMO_SALE_IDS = [
  'sale_vkw_001',
  'sale_vss_001',
  'sale_vss_002',
  'sale_vss_003',
  'sale_vc_001',
  'sale_vc_002',
  'sale_vc_003',
  'sale_vc_004',
] as const;

const DEMO_SALE_LEDGER_IDS = [
  'ledger_vkw_001',
  'ledger_vss_001',
  'ledger_vss_002',
  'ledger_vc_001',
] as const;

const DEMO_LEDGER_IDS = [
  'ledger_vw_001',
  'ledger_vw_002',
  'ledger_vw_003',
  'ledger_vss_003',
  'ledger_vc_002',
  'ledger_vms_001',
  'ledger_vms_002',
  'ledger_vms_003',
  'ledger_vm_001',
  'ledger_vm_002',
  'ledger_vs_001',
  ...DEMO_SALE_LEDGER_IDS,
] as const;

const DEMO_JOB_IDS = [
  'job_vms_001',
  'job_vms_002',
  'job_vms_003',
  'job_vm_001',
  'job_vm_002',
  'job_vm_003',
] as const;

const DEMO_JOB_MATERIAL_IDS = ['jm_vms_001'] as const;
const DEMO_JOB_LABOUR_IDS = ['jl_vms_001'] as const;

const DEMO_APPOINTMENT_IDS = [
  'appt_vs_001',
  'appt_vs_002',
  'appt_vs_003',
  'appt_vs_004',
  'appt_vs_005',
  'appt_vs_006',
] as const;

const DEMO_STOCK_MOVEMENT_IDS = ['mov_vw_in_001', 'mov_vw_out_001'] as const;

const DEMO_ITEM_IDS = [
  'item_001',
  'item_002',
  'item_003',
  'item_004',
  'item_005',
  'item_006',
  'item_007',
  'item_008',
  'item_009',
  'item_010',
  'item_vkw_001',
] as const;

const DEMO_SUPPLIER_IDS = ['sup_vw_001', 'sup_vw_002', 'sup_vw_003'] as const;

const DEMO_CUSTOMER_IDS = [
  'cust_vkw_001',
  'cust_vss_001',
  'cust_vss_002',
  'cust_vss_003',
  'cust_vc_001',
  'cust_vc_002',
  'cust_vc_003',
  'cust_vs_001',
  'cust_vs_002',
  'cust_vs_003',
] as const;

/** Demo audit rows tied to seeded business records (staff audit purge is separate). */
export const DEMO_BUSINESS_AUDIT_IDS = [
  'audit_vkw_sale',
  'audit_vss_sale',
  'audit_vw_item_001',
  'audit_vw_mov_in',
  'audit_vw_mov_out',
  'audit_vw_sup_001',
  'audit_vkw_customer',
  'audit_vms_job_create',
  'audit_vms_job_progress',
  'audit_vm_job_create',
  'audit_vs_appt',
] as const;

/** Removes legacy demo business rows so lists start empty until real data exists. */
export async function purgeDemoBusinessData(prisma: PrismaClient): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { id: { in: [...DEMO_BUSINESS_AUDIT_IDS] } },
        { entityType: 'sale', entityId: { in: [...DEMO_SALE_IDS] } },
        { entityType: 'job', entityId: { in: [...DEMO_JOB_IDS] } },
        { entityType: 'item', entityId: { in: [...DEMO_ITEM_IDS] } },
        { entityType: 'supplier', entityId: { in: [...DEMO_SUPPLIER_IDS] } },
        { entityType: 'stockMovement', entityId: { in: [...DEMO_STOCK_MOVEMENT_IDS] } },
        { entityType: 'customer', entityId: { in: [...DEMO_CUSTOMER_IDS] } },
        { entityType: 'appointment', entityId: { in: [...DEMO_APPOINTMENT_IDS] } },
      ],
    },
  });

  await prisma.saleLine.deleteMany({ where: { saleId: { in: [...DEMO_SALE_IDS] } } });
  await prisma.ledgerEntry.deleteMany({
    where: {
      OR: [
        { id: { in: [...DEMO_LEDGER_IDS] } },
        { linkedRecordType: 'sale', linkedRecordId: { in: [...DEMO_SALE_IDS] } },
        { linkedRecordType: 'job', linkedRecordId: { in: [...DEMO_JOB_IDS] } },
      ],
    },
  });
  await prisma.sale.deleteMany({ where: { id: { in: [...DEMO_SALE_IDS] } } });

  await prisma.jobLabour.deleteMany({ where: { id: { in: [...DEMO_JOB_LABOUR_IDS] } } });
  await prisma.jobMaterial.deleteMany({ where: { id: { in: [...DEMO_JOB_MATERIAL_IDS] } } });
  await prisma.job.deleteMany({ where: { id: { in: [...DEMO_JOB_IDS] } } });

  await prisma.appointment.deleteMany({ where: { id: { in: [...DEMO_APPOINTMENT_IDS] } } });
  await prisma.stockMovement.deleteMany({ where: { id: { in: [...DEMO_STOCK_MOVEMENT_IDS] } } });
  await prisma.item.deleteMany({ where: { id: { in: [...DEMO_ITEM_IDS] } } });
  await prisma.supplier.deleteMany({ where: { id: { in: [...DEMO_SUPPLIER_IDS] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [...DEMO_CUSTOMER_IDS] } } });

  console.log('Demo business data purged');
}
