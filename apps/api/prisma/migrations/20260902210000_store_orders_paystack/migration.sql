-- CreateEnum
CREATE TYPE "StoreOrderStatus" AS ENUM ('pending_payment', 'paid', 'cancelled', 'fulfilled');

-- CreateEnum
CREATE TYPE "StoreFulfillmentType" AS ENUM ('collection', 'fitment', 'delivery');

-- CreateTable
CREATE TABLE "StoreOrder" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "StoreOrderStatus" NOT NULL DEFAULT 'pending_payment',
    "fulfillment" "StoreFulfillmentType" NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "registration" TEXT,
    "notes" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "subtotal" DECIMAL(65,30) NOT NULL,
    "total" DECIMAL(65,30) NOT NULL,
    "paystackReference" TEXT,
    "paystackAccessCode" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPrice" DECIMAL(65,30) NOT NULL,
    "lineTotal" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "StoreOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreOrderSale" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,

    CONSTRAINT "StoreOrderSale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreOrder_reference_key" ON "StoreOrder"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "StoreOrder_paystackReference_key" ON "StoreOrder"("paystackReference");

-- CreateIndex
CREATE INDEX "StoreOrder_status_createdAt_idx" ON "StoreOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "StoreOrderLine_orderId_idx" ON "StoreOrderLine"("orderId");

-- CreateIndex
CREATE INDEX "StoreOrderLine_tenantId_idx" ON "StoreOrderLine"("tenantId");

-- CreateIndex
CREATE INDEX "StoreOrderLine_tenantId_sku_idx" ON "StoreOrderLine"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "StoreOrderSale_saleId_idx" ON "StoreOrderSale"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreOrderSale_orderId_tenantId_key" ON "StoreOrderSale"("orderId", "tenantId");

-- AddForeignKey
ALTER TABLE "StoreOrderLine" ADD CONSTRAINT "StoreOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "StoreOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrderLine" ADD CONSTRAINT "StoreOrderLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrderSale" ADD CONSTRAINT "StoreOrderSale_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "StoreOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrderSale" ADD CONSTRAINT "StoreOrderSale_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrderSale" ADD CONSTRAINT "StoreOrderSale_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
