/**
 * Classify payroll candidates into staff groups for Add Payroll filters.
 * Priority: management → technical → service → other.
 */

export type PayrollStaffBucket =
  | 'management'
  | 'technical'
  | 'service'
  | 'other';

const MANAGEMENT_PATTERNS: RegExp[] = [
  /^admin$/i,
  /^manager/i,
  /manager$/i,
  /^assistant manager/i,
  /^ceo$/i,
  /^c\.?e\.?o\.?$/i,
  /^supervisor/i,
  /^head of/i,
  /^hr\b/i,
  /operations manager/i,
  /saloon manager/i,
  /salon manager/i,
  /^general auditor/i,
  /^procurement manager/i,
  /^technical manager/i,
  /^kidswear ceo/i,
];

const TECHNICAL_PATTERNS: RegExp[] = [
  /^painter$/i,
  /^body works/i,
  /^panel beater$/i,
  /^auto-mechanic$/i,
  /^auto-electrician$/i,
  /^auto-repair/i,
  /^wheel alignment/i,
  /^alignment technician/i,
  /^technical staff$/i,
  /^technical supervisor/i,
  /^mechanic$/i,
  /^technician$/i,
  /^ac technician/i,
  /^machinist$/i,
  /^electrician$/i,
  /^quality control/i,
  /^auto-repair qc/i,
];

function matchesAny(
  value: string | null | undefined,
  patterns: RegExp[],
): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return patterns.some((pattern) => pattern.test(trimmed));
}

export function isManagementStaffLabel(
  name: string | null | undefined,
): boolean {
  return matchesAny(name, MANAGEMENT_PATTERNS);
}

export function isTechnicalStaffLabel(
  name: string | null | undefined,
): boolean {
  return matchesAny(name, TECHNICAL_PATTERNS);
}

/** Resolve bucket from role / designation / department / service flag. */
export function resolvePayrollStaffBucket(args: {
  roleName?: string | null;
  designation?: string | null;
  department?: string | null;
  isServiceStaff?: boolean | null;
  roleIsServiceStaff?: boolean | null;
}): PayrollStaffBucket {
  const labels = [args.roleName, args.designation, args.department];
  if (labels.some((l) => isManagementStaffLabel(l))) return 'management';
  if (labels.some((l) => isTechnicalStaffLabel(l))) return 'technical';
  if (args.isServiceStaff || args.roleIsServiceStaff) return 'service';
  return 'other';
}
