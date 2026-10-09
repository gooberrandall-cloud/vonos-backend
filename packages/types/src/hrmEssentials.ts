import { z } from "zod";

/** Essentials / HRM Settings (Business Settings–style vertical tabs). */
export const HrmSettingsSchema = z.object({
  leave: z
    .object({
      leaveRefNoPrefix: z.string().optional(),
      leaveInstructions: z.string().optional(),
    })
    .optional(),
  payroll: z
    .object({
      payrollRefNoPrefix: z.string().optional(),
    })
    .optional(),
  attendance: z
    .object({
      isLocationRequired: z.boolean().optional(),
      graceBeforeCheckin: z.string().optional(),
      graceAfterCheckin: z.string().optional(),
      graceBeforeCheckout: z.string().optional(),
      graceAfterCheckout: z.string().optional(),
    })
    .optional(),
  salesTargets: z
    .object({
      calculateCommissionWithoutTax: z.boolean().optional(),
    })
    .optional(),
  essentials: z
    .object({
      todosIdPrefix: z.string().optional(),
    })
    .optional(),
});

export type HrmSettings = z.infer<typeof HrmSettingsSchema>;

export function defaultHrmSettings(): HrmSettings {
  return {
    leave: { leaveRefNoPrefix: "", leaveInstructions: "" },
    payroll: { payrollRefNoPrefix: "VPR-" },
    attendance: {
      isLocationRequired: false,
      graceBeforeCheckin: "5",
      graceAfterCheckin: "5",
      graceBeforeCheckout: "5",
      graceAfterCheckout: "5",
    },
    salesTargets: { calculateCommissionWithoutTax: false },
    essentials: { todosIdPrefix: "" },
  };
}

export function mergeHrmSettings(
  current: HrmSettings | undefined,
  patch: HrmSettings | undefined,
): HrmSettings {
  const base = defaultHrmSettings();
  return {
    leave: { ...base.leave, ...current?.leave, ...patch?.leave },
    payroll: { ...base.payroll, ...current?.payroll, ...patch?.payroll },
    attendance: {
      ...base.attendance,
      ...current?.attendance,
      ...patch?.attendance,
    },
    salesTargets: {
      ...base.salesTargets,
      ...current?.salesTargets,
      ...patch?.salesTargets,
    },
    essentials: {
      ...base.essentials,
      ...current?.essentials,
      ...patch?.essentials,
    },
  };
}

export interface LeaveTypeRow {
  id: string;
  tenantId: string;
  name: string;
  maxLeaveCount: number;
  createdAt: string;
}

export interface LeaveRow {
  id: string;
  tenantId: string;
  referenceNo: string | null;
  leaveTypeId: string | null;
  leaveTypeName: string | null;
  employeeName: string;
  employeeRecordId: string | null;
  designationId: string | null;
  leaveDate: string;
  reason: string | null;
  status: string;
  createdAt: string;
}

export interface HolidayRow {
  id: string;
  tenantId: string;
  name: string;
  date: string;
  locationCode: string | null;
  note: string | null;
  createdAt: string;
}

export interface AttendanceShiftRow {
  id: string;
  tenantId: string;
  name: string;
  createdAt: string;
}

export interface AttendanceRow {
  id: string;
  tenantId: string;
  employeeName: string;
  shiftId: string | null;
  shiftName: string | null;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  status: string;
  createdAt: string;
}

export interface AttendanceByShiftRow {
  id: string;
  shift: string;
  present: number;
  absent: number;
}

export interface SalesTargetRow {
  id: string;
  tenantId: string;
  userName: string;
  userId: string | null;
  createdAt: string;
}

export interface DepartmentRow {
  id: string;
  tenantId: string;
  name: string;
  code: string | null;
  description: string | null;
  createdAt: string;
}
