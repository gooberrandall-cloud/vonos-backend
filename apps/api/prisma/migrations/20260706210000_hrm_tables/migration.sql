-- HRM: payroll groups, pay components, payroll runs

CREATE TABLE IF NOT EXISTS "PayrollGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PayrollGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PayComponent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'allowance',
    "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PayComponent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Payroll" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payrollGroupId" TEXT,
    "employeeName" TEXT NOT NULL,
    "employeeId" TEXT,
    "locationCode" TEXT,
    "grossPay" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalAllowance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalDeduction" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "netPay" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "paymentStatus" TEXT NOT NULL DEFAULT 'due',
    "payrollMonth" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Payroll_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PayrollGroup_tenantId_idx" ON "PayrollGroup"("tenantId");
CREATE INDEX IF NOT EXISTS "PayComponent_tenantId_idx" ON "PayComponent"("tenantId");
CREATE INDEX IF NOT EXISTS "Payroll_tenantId_idx" ON "Payroll"("tenantId");
CREATE INDEX IF NOT EXISTS "Payroll_payrollGroupId_idx" ON "Payroll"("payrollGroupId");
CREATE INDEX IF NOT EXISTS "Payroll_tenantId_payrollMonth_idx" ON "Payroll"("tenantId", "payrollMonth");

DO $$ BEGIN
  ALTER TABLE "PayrollGroup" ADD CONSTRAINT "PayrollGroup_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PayComponent" ADD CONSTRAINT "PayComponent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_payrollGroupId_fkey"
    FOREIGN KEY ("payrollGroupId") REFERENCES "PayrollGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
