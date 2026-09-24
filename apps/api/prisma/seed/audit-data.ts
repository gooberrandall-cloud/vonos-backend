import type { PrismaClient } from '@prisma/client';

const DEMO_STAFF_USER_IDS = [
  'user_vms_staff_tunde',
  'user_vms_staff_grace',
  'user_vkw_staff',
] as const;

const DEMO_STAFF_EMAILS = [
  'tunde@vms.vonos',
  'grace@vms.vonos',
  'sari@vkw.vonos',
] as const;

/** Removes demo staff accounts and any audit rows they acted on. */
export async function purgeDemoStaffAndAudit(prisma: PrismaClient): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: { actorUserId: { in: [...DEMO_STAFF_USER_IDS] } },
  });

  await prisma.authToken.deleteMany({
    where: { userId: { in: [...DEMO_STAFF_USER_IDS] } },
  });

  await prisma.user.deleteMany({
    where: {
      OR: [
        { id: { in: [...DEMO_STAFF_USER_IDS] } },
        { email: { in: [...DEMO_STAFF_EMAILS] } },
      ],
    },
  });

  console.log('Demo staff and audit actors purged');
}
