import { BadRequestException } from '@nestjs/common';
import type { Archetype, PrismaClient } from '@prisma/client';

/**
 * Minimal registry for tenants the app routes expect even if seed was skipped.
 * Used to heal FK failures (e.g. TenantRole → Tenant) when a code is live in
 * the frontend but missing from Postgres.
 */
export const OPERATING_TENANTS: ReadonlyArray<{
  id: string;
  code: string;
  name: string;
  archetype: Archetype;
}> = [
  {
    id: 'tenant_vw_001',
    code: 'VW',
    name: 'Vonos Warehouse',
    archetype: 'stock',
  },
  {
    id: 'tenant_vkw_001',
    code: 'VKW',
    name: 'Vonos Kids Wear',
    archetype: 'stock',
  },
  {
    id: 'tenant_visp_001',
    code: 'VISP',
    name: 'Vonos Institute Spare Parts',
    archetype: 'transaction',
  },
  {
    id: 'tenant_vsp_001',
    code: 'VSP',
    name: 'Vonos SP Marketplace',
    archetype: 'transaction',
  },
  {
    id: 'tenant_vc_001',
    code: 'VC',
    name: 'Vonos Cafe',
    archetype: 'transaction',
  },
  {
    id: 'tenant_va_001',
    code: 'VA',
    name: 'Vonos Mechanic',
    archetype: 'job',
  },
  {
    id: 'tenant_vp_001',
    code: 'VP',
    name: 'Vonos Painting',
    archetype: 'job',
  },
  {
    id: 'tenant_vs_001',
    code: 'VS',
    name: 'Vonos Saloon',
    archetype: 'appointment',
  },
  {
    id: 'tenant_vag_001',
    code: 'VAG',
    name: 'Vonos Autos Group',
    archetype: 'stock',
  },
];

function minimalConfig(tenant: (typeof OPERATING_TENANTS)[number]) {
  return {
    tenantId: tenant.id,
    code: tenant.code,
    name: tenant.name,
    archetype: tenant.archetype,
    navItems: [],
    enabledModules: [],
    kpiCards: [],
    terminology: {},
  };
}

/** Ensures a Tenant row exists for `tenantId` (create from registry if missing). */
export async function ensureOperatingTenant(
  prisma: PrismaClient,
  tenantId: string,
): Promise<void> {
  const existing = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });
  if (existing) return;

  const known = OPERATING_TENANTS.find((row) => row.id === tenantId);
  if (!known) {
    throw new BadRequestException(
      `Tenant “${tenantId}” does not exist. Re-run seed or create the tenant first.`,
    );
  }

  const byCode = await prisma.tenant.findUnique({
    where: { code: known.code },
    select: { id: true },
  });
  if (byCode) {
    throw new BadRequestException(
      `Tenant code ${known.code} exists with id ${byCode.id}, but roles were requested for ${tenantId}.`,
    );
  }

  await prisma.tenant.create({
    data: {
      id: known.id,
      code: known.code,
      name: known.name,
      archetype: known.archetype,
      config: minimalConfig(known),
    },
  });
}
