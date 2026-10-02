/**
 * Set each product-own-scope tenant's `config.businessLocations` to that
 * tenant's own home only (VSP → Vonos SP Marketplace, etc.).
 *
 * Cross-entity moves still use PRODUCT_STOCK_BUSINESS_LOCATIONS in the UI;
 * catalog / price edits should not list sister warehouses as product homes.
 *
 * Usage: npx tsx prisma/scripts/sync-product-stock-locations.ts
 */
import { PrismaClient, type Prisma } from '@prisma/client';

const PRODUCT_HOME_BY_CODE = {
  VA: { code: 'VA', name: 'Vonos Mechanic' },
  VP: { code: 'VP', name: 'Vonos Painting' },
  VW: { code: 'VW', name: 'Vonos Warehouse' },
  VISP: { code: 'VISP', name: 'Vonos Institute Spare Parts' },
  VSP: { code: 'VSP', name: 'Vonos SP Marketplace' },
} as const;

const TARGET_CODES = Object.keys(PRODUCT_HOME_BY_CODE);

type Loc = {
  code: string;
  name: string;
  landmark?: string;
  city?: string;
  zipCode?: string;
  state?: string;
  country?: string;
  mobile?: string;
  alternateNumber?: string;
  email?: string;
};

async function main() {
  const prisma = new PrismaClient();
  try {
    const tenants = await prisma.tenant.findMany({
      where: { code: { in: TARGET_CODES } },
      select: { id: true, code: true, config: true },
    });

    for (const tenant of tenants) {
      const code = tenant.code.trim().toUpperCase() as keyof typeof PRODUCT_HOME_BY_CODE;
      const home = PRODUCT_HOME_BY_CODE[code];
      if (!home) continue;

      const config = (tenant.config ?? {}) as Record<string, unknown>;
      const existing = Array.isArray(config.businessLocations)
        ? (config.businessLocations as Loc[])
        : [];
      const prev = existing.find(
        (row) => row.code?.trim().toUpperCase() === home.code,
      );

      const next: Loc[] = [
        {
          ...home,
          landmark: prev?.landmark,
          city: prev?.city,
          zipCode: prev?.zipCode,
          state: prev?.state,
          country: prev?.country,
          mobile: prev?.mobile,
          alternateNumber: prev?.alternateNumber,
          email: prev?.email,
        },
      ];

      const nextConfig = {
        ...config,
        businessLocations: next,
      } as unknown as Prisma.InputJsonValue;

      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { config: nextConfig },
      });

      console.log(`Updated ${tenant.code}: ${next.map((l) => l.code).join(', ')}`);
    }

    console.log(`Done. ${tenants.length} tenant(s) updated.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
