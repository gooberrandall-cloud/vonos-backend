-- Service staff: employee flag + sale assignment (not legacy POS role imports).
ALTER TABLE "Employee" ADD COLUMN "isServiceStaff" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Employee_tenantId_isServiceStaff_idx"
  ON "Employee"("tenantId", "isServiceStaff");

ALTER TABLE "Sale" ADD COLUMN "serviceStaffEmployeeId" TEXT;

ALTER TABLE "Sale"
  ADD CONSTRAINT "Sale_serviceStaffEmployeeId_fkey"
  FOREIGN KEY ("serviceStaffEmployeeId") REFERENCES "Employee"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Sale_tenantId_serviceStaffEmployeeId_idx"
  ON "Sale"("tenantId", "serviceStaffEmployeeId");
