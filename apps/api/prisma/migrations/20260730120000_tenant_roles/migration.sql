-- CreateTable
CREATE TABLE "TenantRole" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isServiceStaff" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TenantRole_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "User" ADD COLUMN "tenantRoleId" TEXT;

-- CreateIndex
CREATE INDEX "TenantRole_tenantId_idx" ON "TenantRole"("tenantId");

-- CreateIndex
CREATE INDEX "TenantRole_tenantId_name_idx" ON "TenantRole"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TenantRole_tenantId_name_key" ON "TenantRole"("tenantId", "name");

-- CreateIndex
CREATE INDEX "User_tenantRoleId_idx" ON "User"("tenantRoleId");

-- AddForeignKey
ALTER TABLE "TenantRole" ADD CONSTRAINT "TenantRole_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantRoleId_fkey" FOREIGN KEY ("tenantRoleId") REFERENCES "TenantRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
