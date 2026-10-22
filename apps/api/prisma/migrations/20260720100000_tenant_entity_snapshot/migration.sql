-- TenantEntitySnapshot: materialized entity card stats for VAG group overview
CREATE TABLE "TenantEntitySnapshot" (
    "tenantId" TEXT NOT NULL,
    "archetype" TEXT NOT NULL,
    "sku" INTEGER NOT NULL DEFAULT 0,
    "stockValue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "lowStock" INTEGER NOT NULL DEFAULT 0,
    "inboundToday" INTEGER NOT NULL DEFAULT 0,
    "salesTodayRevenue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "salesReturns" INTEGER NOT NULL DEFAULT 0,
    "activeJobs" INTEGER NOT NULL DEFAULT 0,
    "pendingQc" INTEGER NOT NULL DEFAULT 0,
    "jobRevenueToday" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "apptsToday" INTEGER NOT NULL DEFAULT 0,
    "apptRevenueToday" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "retailLowStock" INTEGER NOT NULL DEFAULT 0,
    "pendingInbound" INTEGER NOT NULL DEFAULT 0,
    "refreshedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantEntitySnapshot_pkey" PRIMARY KEY ("tenantId")
);

ALTER TABLE "TenantEntitySnapshot" ADD CONSTRAINT "TenantEntitySnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
