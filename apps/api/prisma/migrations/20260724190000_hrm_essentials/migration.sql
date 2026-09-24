-- HRM essentials: leave, holiday, attendance, sales targets + department/designation fields

ALTER TABLE "Designation" ADD COLUMN IF NOT EXISTS "description" TEXT;

ALTER TABLE "PayrollGroup" ADD COLUMN IF NOT EXISTS "code" TEXT;
ALTER TABLE "PayrollGroup" ADD COLUMN IF NOT EXISTS "description" TEXT;

CREATE TABLE IF NOT EXISTS "LeaveType" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxLeaveCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Leave" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "referenceNo" TEXT,
    "leaveTypeId" TEXT,
    "employeeName" TEXT NOT NULL,
    "employeeRecordId" TEXT,
    "designationId" TEXT,
    "leaveDate" DATE NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "Leave_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Holiday" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "locationCode" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AttendanceShift" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "AttendanceShift_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Attendance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "shiftId" TEXT,
    "date" DATE NOT NULL,
    "clockIn" TIMESTAMP(3),
    "clockOut" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'present',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SalesTarget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "userId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "SalesTarget_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LeaveType_tenantId_idx" ON "LeaveType"("tenantId");
CREATE INDEX IF NOT EXISTS "LeaveType_tenantId_name_idx" ON "LeaveType"("tenantId", "name");
CREATE INDEX IF NOT EXISTS "Leave_tenantId_idx" ON "Leave"("tenantId");
CREATE INDEX IF NOT EXISTS "Leave_tenantId_leaveDate_idx" ON "Leave"("tenantId", "leaveDate");
CREATE INDEX IF NOT EXISTS "Leave_tenantId_status_idx" ON "Leave"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "Holiday_tenantId_idx" ON "Holiday"("tenantId");
CREATE INDEX IF NOT EXISTS "Holiday_tenantId_date_idx" ON "Holiday"("tenantId", "date");
CREATE INDEX IF NOT EXISTS "AttendanceShift_tenantId_idx" ON "AttendanceShift"("tenantId");
CREATE INDEX IF NOT EXISTS "Attendance_tenantId_idx" ON "Attendance"("tenantId");
CREATE INDEX IF NOT EXISTS "Attendance_tenantId_date_idx" ON "Attendance"("tenantId", "date");
CREATE INDEX IF NOT EXISTS "Attendance_tenantId_shiftId_date_idx" ON "Attendance"("tenantId", "shiftId", "date");
CREATE INDEX IF NOT EXISTS "SalesTarget_tenantId_idx" ON "SalesTarget"("tenantId");
CREATE INDEX IF NOT EXISTS "SalesTarget_tenantId_userName_idx" ON "SalesTarget"("tenantId", "userName");

DO $$ BEGIN
  ALTER TABLE "LeaveType" ADD CONSTRAINT "LeaveType_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Leave" ADD CONSTRAINT "Leave_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Leave" ADD CONSTRAINT "Leave_leaveTypeId_fkey"
    FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AttendanceShift" ADD CONSTRAINT "AttendanceShift_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "AttendanceShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SalesTarget" ADD CONSTRAINT "SalesTarget_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
