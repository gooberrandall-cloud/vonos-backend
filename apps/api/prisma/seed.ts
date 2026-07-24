import { PrismaClient } from '@prisma/client';
import { purgeDemoStaffAndAudit } from './seed/audit-data';
import { purgeDemoBusinessData } from './seed/business-data';
import { seedHrmDemo } from './seed/hrm';
import { seedTenantsAndUsers } from './seed/tenants';

const prisma = new PrismaClient();

async function main() {
  await seedTenantsAndUsers(prisma);
  await purgeDemoBusinessData(prisma);
  await purgeDemoStaffAndAudit(prisma);
  await seedHrmDemo(prisma);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
