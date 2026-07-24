-- CreateEnum
CREATE TYPE "Role" AS ENUM ('super_admin', 'admin', 'manager', 'staff', 'viewer');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('invited', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "Archetype" AS ENUM ('stock', 'transaction', 'job', 'appointment');

-- CreateEnum
CREATE TYPE "StockStatus" AS ENUM ('in_stock', 'low_stock', 'out_of_stock');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('revenue', 'cost', 'expense');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('inbound', 'outbound', 'transfer');

-- CreateEnum
CREATE TYPE "MovementStatus" AS ENUM ('Pending', 'Approved', 'Received', 'Shipped', 'Delivered');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('paid', 'partial', 'due');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('completed', 'refunded', 'partially_refunded', 'draft');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archetype" "Archetype" NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'invited',
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "binLocation" TEXT,
    "reorderPoint" INTEGER,
    "costPrice" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "StockStatus" NOT NULL DEFAULT 'in_stock',
    "availableForRetail" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "MovementType" NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "MovementStatus" NOT NULL DEFAULT 'Pending',
    "lines" JSONB NOT NULL,
    "notes" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "hasQuote" BOOLEAN NOT NULL DEFAULT false,
    "quoteAmount" DECIMAL(65,30),
    "customerName" TEXT,
    "vehicleId" TEXT,
    "assignedStaffIds" TEXT[],
    "dueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobMaterial" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "itemId" TEXT,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unitCost" DECIMAL(65,30) NOT NULL,
    "totalCost" DECIMAL(65,30) NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobLabour" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "hours" DECIMAL(65,30) NOT NULL,
    "rate" DECIMAL(65,30) NOT NULL,
    "totalCost" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobLabour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "linkedRecordType" TEXT,
    "linkedRecordId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "customerId" TEXT,
    "total" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "SaleStatus" NOT NULL DEFAULT 'completed',
    "paymentStatus" "PaymentStatus",
    "date" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleLine" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "itemId" TEXT,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unitPrice" DECIMAL(65,30) NOT NULL,
    "lineTotal" DECIMAL(65,30) NOT NULL,
    "discountAmount" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationLegacyId" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "newId" TEXT NOT NULL,

    CONSTRAINT "MigrationLegacyId_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "linkedRecordType" TEXT,
    "linkedRecordId" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_code_key" ON "Tenant"("code");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE INDEX "Item_tenantId_idx" ON "Item"("tenantId");

-- CreateIndex
CREATE INDEX "Item_tenantId_status_idx" ON "Item"("tenantId", "status");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_idx" ON "StockMovement"("tenantId");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_type_idx" ON "StockMovement"("tenantId", "type");

-- CreateIndex
CREATE INDEX "Supplier_tenantId_idx" ON "Supplier"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_reference_key" ON "Job"("reference");

-- CreateIndex
CREATE INDEX "Job_tenantId_idx" ON "Job"("tenantId");

-- CreateIndex
CREATE INDEX "Job_tenantId_status_idx" ON "Job"("tenantId", "status");

-- CreateIndex
CREATE INDEX "LedgerEntry_tenantId_idx" ON "LedgerEntry"("tenantId");

-- CreateIndex
CREATE INDEX "LedgerEntry_tenantId_date_idx" ON "LedgerEntry"("tenantId", "date");

-- CreateIndex
CREATE INDEX "LedgerEntry_tenantId_type_idx" ON "LedgerEntry"("tenantId", "type");

-- CreateIndex
CREATE INDEX "Customer_tenantId_idx" ON "Customer"("tenantId");

-- CreateIndex
CREATE INDEX "Sale_tenantId_idx" ON "Sale"("tenantId");

-- CreateIndex
CREATE INDEX "Sale_tenantId_date_idx" ON "Sale"("tenantId", "date");

-- CreateIndex
CREATE INDEX "Sale_customerId_idx" ON "Sale"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_tenantId_reference_key" ON "Sale"("tenantId", "reference");

-- CreateIndex
CREATE INDEX "SaleLine_saleId_idx" ON "SaleLine"("saleId");

-- CreateIndex
CREATE INDEX "SaleLine_itemId_idx" ON "SaleLine"("itemId");

-- CreateIndex
CREATE INDEX "MigrationLegacyId_tenantId_entityType_idx" ON "MigrationLegacyId"("tenantId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationLegacyId_tenantId_entityType_legacyId_key" ON "MigrationLegacyId"("tenantId", "entityType", "legacyId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_idx" ON "Notification"("tenantId");

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobMaterial" ADD CONSTRAINT "JobMaterial_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobLabour" ADD CONSTRAINT "JobLabour_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationLegacyId" ADD CONSTRAINT "MigrationLegacyId_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
