/**
 * Make products, customers, suppliers, and customer groups identical across
 * operating entities. Builds a union from all operating tenants, then fills
 * gaps on each (item qty = 0). Skips VAG (admin) and retired VM/VMS codes.
 *
 * Usage (from apps/api):
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/scripts/sync-master-data-across-tenants.ts
 *   npx ts-node ... sync-master-data-across-tenants.ts --dry-run
 */
import { PrismaClient, type Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const BATCH = 250;

const OPERATING = new Set([
  'VA',
  'VW',
  'VISP',
  'VSP',
  'VP',
  'VC',
  'VS',
  'VKW',
]);

function skuKey(sku: string): string {
  return sku.trim().toUpperCase();
}

function contactKey(
  name: string,
  email: string | null,
  phone: string | null,
): string {
  const e = email?.trim().toLowerCase() ?? '';
  const p = phone?.replace(/\D/g, '') ?? '';
  if (e) return `e:${e}`;
  if (p.length >= 7) return `p:${p}`;
  return `n:${name.trim().toLowerCase()}`;
}

async function main() {
  const tenants = (
    await prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true, code: true },
    })
  ).filter((t) => OPERATING.has(t.code.toUpperCase()));

  if (tenants.length < 2) {
    console.log('Need at least 2 operating tenants.');
    return;
  }

  console.log(
    JSON.stringify(
      { dryRun, tenants: tenants.map((t) => t.code) },
      null,
      2,
    ),
  );

  type ItemSeed = Prisma.ItemCreateManyInput;
  type CustomerSeed = Prisma.CustomerCreateManyInput;
  type SupplierSeed = Prisma.SupplierCreateManyInput;

  const itemBySku = new Map<string, ItemSeed>();
  const customerByKey = new Map<string, CustomerSeed>();
  const supplierByKey = new Map<string, SupplierSeed>();

  for (const t of tenants) {
    const items = await prisma.item.findMany({
      where: { tenantId: t.id, deletedAt: null },
      select: {
        sku: true,
        name: true,
        category: true,
        subCategory: true,
        description: true,
        barcodeType: true,
        unit: true,
        weight: true,
        carModel: true,
        imageUrl: true,
        enableImei: true,
        preparationMinutes: true,
        reorderPoint: true,
        costPrice: true,
        sellPrice: true,
        currency: true,
        availableForRetail: true,
      },
    });
    for (const item of items) {
      const key = skuKey(item.sku);
      if (!key || itemBySku.has(key)) continue;
      itemBySku.set(key, {
        sku: item.sku,
        name: item.name,
        category: item.category,
        subCategory: item.subCategory,
        description: item.description,
        barcodeType: item.barcodeType,
        unit: item.unit,
        weight: item.weight,
        carModel: item.carModel,
        imageUrl: item.imageUrl,
        enableImei: item.enableImei,
        preparationMinutes: item.preparationMinutes,
        quantity: 0,
        reorderPoint: item.reorderPoint,
        costPrice: item.costPrice,
        sellPrice: item.sellPrice,
        currency: item.currency,
        status: 'out_of_stock',
        availableForRetail: true,
        brandId: null,
        tenantId: '', // filled per target
      });
    }

    const customers = await prisma.customer.findMany({
      where: { tenantId: t.id, deletedAt: null },
      select: {
        name: true,
        email: true,
        phone: true,
        taxNumber: true,
        details: true,
        status: true,
      },
    });
    for (const c of customers) {
      const key = contactKey(c.name, c.email, c.phone);
      if (customerByKey.has(key)) continue;
      customerByKey.set(key, {
        name: c.name,
        email: c.email,
        phone: c.phone,
        taxNumber: c.taxNumber,
        details:
          c.details === null ? undefined : (c.details as Prisma.InputJsonValue),
        status: c.status || 'active',
        openingBalance: 0,
        totalSell: 0,
        totalSellDue: 0,
        totalSellPaid: 0,
        totalSellReturn: 0,
        totalAdvance: 0,
        visitCount: 0,
        tenantId: '',
      });
    }

    const suppliers = await prisma.supplier.findMany({
      where: { tenantId: t.id, deletedAt: null },
      select: {
        name: true,
        contactName: true,
        email: true,
        phone: true,
        address: true,
        notes: true,
        taxNumber: true,
        accountHolderName: true,
        bankName: true,
        bankBranch: true,
        bankCode: true,
        bankAccountNo: true,
        taxPayerId: true,
        status: true,
      },
    });
    for (const s of suppliers) {
      const key = contactKey(s.name, s.email, s.phone);
      if (supplierByKey.has(key)) continue;
      supplierByKey.set(key, {
        name: s.name,
        contactName: s.contactName,
        email: s.email,
        phone: s.phone,
        address: s.address,
        notes: s.notes,
        taxNumber: s.taxNumber,
        accountHolderName: s.accountHolderName,
        bankName: s.bankName,
        bankBranch: s.bankBranch,
        bankCode: s.bankCode,
        bankAccountNo: s.bankAccountNo,
        taxPayerId: s.taxPayerId,
        status: s.status || 'active',
        openingBalance: 0,
        totalPurchase: 0,
        totalPurchaseDue: 0,
        totalPurchasePaid: 0,
        totalPurchaseReturn: 0,
        totalAdvance: 0,
        tenantId: '',
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        union: {
          items: itemBySku.size,
          customers: customerByKey.size,
          suppliers: supplierByKey.size,
        },
      },
      null,
      2,
    ),
  );

  let itemsCreated = 0;
  let customersCreated = 0;
  let suppliersCreated = 0;

  for (const target of tenants) {
    const existingSkus = new Set(
      (
        await prisma.item.findMany({
          where: { tenantId: target.id, deletedAt: null },
          select: { sku: true },
        })
      ).map((i) => skuKey(i.sku)),
    );
    const itemCreates: Prisma.ItemCreateManyInput[] = [];
    for (const [key, seed] of itemBySku) {
      if (existingSkus.has(key)) continue;
      itemCreates.push({ ...seed, tenantId: target.id });
    }

    const existingCustomers = new Set(
      (
        await prisma.customer.findMany({
          where: { tenantId: target.id, deletedAt: null },
          select: { name: true, email: true, phone: true },
        })
      ).map((c) => contactKey(c.name, c.email, c.phone)),
    );
    const customerCreates: Prisma.CustomerCreateManyInput[] = [];
    for (const [key, seed] of customerByKey) {
      if (existingCustomers.has(key)) continue;
      customerCreates.push({ ...seed, tenantId: target.id });
    }

    const existingSuppliers = new Set(
      (
        await prisma.supplier.findMany({
          where: { tenantId: target.id, deletedAt: null },
          select: { name: true, email: true, phone: true },
        })
      ).map((s) => contactKey(s.name, s.email, s.phone)),
    );
    const supplierCreates: Prisma.SupplierCreateManyInput[] = [];
    for (const [key, seed] of supplierByKey) {
      if (existingSuppliers.has(key)) continue;
      supplierCreates.push({ ...seed, tenantId: target.id });
    }

    console.log(
      JSON.stringify({
        target: target.code,
        willCreate: {
          items: itemCreates.length,
          customers: customerCreates.length,
          suppliers: supplierCreates.length,
        },
      }),
    );

    if (dryRun) continue;

    for (let i = 0; i < itemCreates.length; i += BATCH) {
      const res = await prisma.item.createMany({
        data: itemCreates.slice(i, i + BATCH),
        skipDuplicates: true,
      });
      itemsCreated += res.count;
    }
    for (let i = 0; i < customerCreates.length; i += BATCH) {
      const res = await prisma.customer.createMany({
        data: customerCreates.slice(i, i + BATCH),
        skipDuplicates: true,
      });
      customersCreated += res.count;
    }
    for (let i = 0; i < supplierCreates.length; i += BATCH) {
      const res = await prisma.supplier.createMany({
        data: supplierCreates.slice(i, i + BATCH),
        skipDuplicates: true,
      });
      suppliersCreated += res.count;
    }

    // Existing catalog rows should sell on every retail platform too.
    await prisma.item.updateMany({
      where: {
        tenantId: target.id,
        deletedAt: null,
        availableForRetail: false,
      },
      data: { availableForRetail: true },
    });
  }

  console.log(
    JSON.stringify(
      { dryRun, itemsCreated, customersCreated, suppliersCreated },
      null,
      2,
    ),
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
