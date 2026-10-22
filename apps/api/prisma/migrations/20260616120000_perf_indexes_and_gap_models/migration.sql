-- Gap models from API audit + performance indexes

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "vin" TEXT,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER,
    "ownerName" TEXT NOT NULL,
    "ownerPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Requisition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "jobId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Requisition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalonService" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "price" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SalonService_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CafeTable" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "capacity" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CafeTable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_tenantId_plateNumber_key" ON "Vehicle"("tenantId", "plateNumber");
CREATE INDEX "Vehicle_tenantId_idx" ON "Vehicle"("tenantId");

CREATE UNIQUE INDEX "Requisition_tenantId_reference_key" ON "Requisition"("tenantId", "reference");
CREATE INDEX "Requisition_tenantId_idx" ON "Requisition"("tenantId");
CREATE INDEX "Requisition_tenantId_status_idx" ON "Requisition"("tenantId", "status");

CREATE INDEX "SalonService_tenantId_idx" ON "SalonService"("tenantId");

CREATE UNIQUE INDEX "CafeTable_tenantId_label_key" ON "CafeTable"("tenantId", "label");
CREATE INDEX "CafeTable_tenantId_idx" ON "CafeTable"("tenantId");

CREATE INDEX "Item_tenantId_availableForRetail_idx" ON "Item"("tenantId", "availableForRetail");
CREATE INDEX "StockMovement_tenantId_date_idx" ON "StockMovement"("tenantId", "date");
CREATE INDEX "StockMovement_tenantId_type_date_idx" ON "StockMovement"("tenantId", "type", "date");
CREATE INDEX "Job_tenantId_createdAt_idx" ON "Job"("tenantId", "createdAt");
CREATE INDEX "JobMaterial_jobId_idx" ON "JobMaterial"("jobId");
CREATE INDEX "JobLabour_jobId_idx" ON "JobLabour"("jobId");
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Requisition" ADD CONSTRAINT "Requisition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalonService" ADD CONSTRAINT "SalonService_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CafeTable" ADD CONSTRAINT "CafeTable_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
