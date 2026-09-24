/**
 * Who counts as service / workshop staff for sales assignment and reports.
 * Intentionally excludes legacy Ultimate POS mis-tags (Office Assistant,
 * Domestic Driver, managers) unless the Settings → Roles "Service Staff"
 * toggle is on for that user's job role.
 *
 * Matches designation OR department (Users HR form) across automotive,
 * retail, salon, and cafe entities.
 */

export const SERVICE_STAFF_DESIGNATION_PATTERNS: RegExp[] = [
  /^painter$/i,
  /^body works/i,
  /^panel beater$/i,
  /^auto-mechanic$/i,
  /^auto-electrician$/i,
  /^wheel alignment/i,
  /^technical staff$/i,
  /^cleaner$/i,
  /^mechanic$/i,
  /^technician$/i,
  /^service staff$/i,
  /^stylist$/i,
  /^hair/i,
  /^barber$/i,
  /^beautician$/i,
  /^nail/i,
  /^spa/i,
  /^makeup/i,
  /^manicur/i,
  /^pedicur/i,
  /^massage/i,
  /^therapist$/i,
  /^cosmetolog/i,
  /^waiter/i,
  /^waitress/i,
  /^barista$/i,
  /^chef$/i,
  /^cook$/i,
  /^kitchen/i,
  /^cashier$/i,
  /^attendant$/i,
  /^sales (?:rep|representative|person|staff)/i,
];

/** Department field on Employee / user HR profile (free text). */
export const SERVICE_STAFF_DEPARTMENT_PATTERNS: RegExp[] = [
  /workshop/i,
  /paint/i,
  /body\s*work/i,
  /mechanic/i,
  /technical/i,
  /service/i,
  /salon/i,
  /saloon/i,
  /hair/i,
  /beauty/i,
  /spa/i,
  /kitchen/i,
  /cafe/i,
  /restaurant/i,
  /barista/i,
  /floor\s*staff/i,
  /sales/i,
  /retail/i,
  /store/i,
  /front\s*desk/i,
];

function matchesAny(
  value: string | null | undefined,
  patterns: RegExp[],
): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return patterns.some((pattern) => pattern.test(trimmed));
}

export function isServiceStaffDesignation(
  name: string | null | undefined,
): boolean {
  return matchesAny(name, SERVICE_STAFF_DESIGNATION_PATTERNS);
}

export function isServiceStaffDepartment(
  name: string | null | undefined,
): boolean {
  return matchesAny(name, SERVICE_STAFF_DEPARTMENT_PATTERNS);
}

/** Unified eligibility: role toggle OR designation OR department. */
export function isServiceStaffEligible(args: {
  roleIsServiceStaff?: boolean | null;
  designation?: string | null;
  department?: string | null;
}): boolean {
  if (args.roleIsServiceStaff) return true;
  if (isServiceStaffDesignation(args.designation)) return true;
  if (isServiceStaffDepartment(args.department)) return true;
  return false;
}
