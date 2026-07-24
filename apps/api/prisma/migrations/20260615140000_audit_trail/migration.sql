-- AlterTable
ALTER TABLE "Item" ADD COLUMN "createdByUserId" TEXT,
ADD COLUMN "createdByName" TEXT;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN "createdByUserId" TEXT,
ADD COLUMN "createdByName" TEXT;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN "createdByUserId" TEXT,
ADD COLUMN "createdByName" TEXT;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "createdByUserId" TEXT,
ADD COLUMN "createdByName" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "createdByUserId" TEXT,
ADD COLUMN "createdByName" TEXT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN "createdByUserId" TEXT,
ADD COLUMN "createdByName" TEXT;

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "legacyLogId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_entityType_entityId_occurredAt_idx" ON "AuditLog"("tenantId", "entityType", "entityId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_occurredAt_idx" ON "AuditLog"("tenantId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_tenantId_legacyLogId_key" ON "AuditLog"("tenantId", "legacyLogId");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
