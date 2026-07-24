/**
 * Designations that count as service / workshop staff for sales assignment and reports.
 * Intentionally excludes legacy Ultimate POS "service staff" roles such as
 * Office Assistant, Domestic Driver, and managers — those were mis-tagged in HQ.
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
];

export function isServiceStaffDesignation(name: string | null | undefined): boolean {
  const trimmed = name?.trim();
  if (!trimmed) return false;
  return SERVICE_STAFF_DESIGNATION_PATTERNS.some((pattern) =>
    pattern.test(trimmed),
  );
}
