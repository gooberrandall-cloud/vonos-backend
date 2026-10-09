/**
 * Map payroll / work-location codes onto operating tenant URL codes.
 * Admin assigns VW|VM|VP|VISP|VSP on the user form; staff switch among those
 * entities in the header.
 */
const LOCATION_TO_TENANT: Record<string, string> = {
  VW: 'VW',
  VA: 'VA',
  VM: 'VA',
  VMS: 'VA',
  VP: 'VP',
  VISP: 'VISP',
  VSS: 'VISP',
  VSP: 'VSP',
  VC: 'VC',
  VS: 'VS',
  VKW: 'VKW',
};

export function normalizeWorkLocationToTenantCode(
  code: string | null | undefined,
): string | null {
  const raw = code?.trim().toUpperCase();
  if (!raw) return null;
  return LOCATION_TO_TENANT[raw] ?? null;
}

/**
 * All work-location tags that grant clearance for a tenant URL code
 * (e.g. VA ← VA, VM, VMS).
 */
export function locationCodesForTenantCode(
  tenantCode: string | null | undefined,
): string[] {
  const target = normalizeWorkLocationToTenantCode(tenantCode);
  if (!target) return [];
  const aliases = Object.entries(LOCATION_TO_TENANT)
    .filter(([, mapped]) => mapped === target)
    .map(([loc]) => loc);
  if (!aliases.includes(target)) aliases.push(target);
  return aliases;
}

export function uniqueTenantCodesFromWorkLocations(
  codes: string[] | null | undefined,
  homeTenantCode?: string | null,
): string[] {
  const out = new Set<string>();
  for (const code of codes ?? []) {
    const mapped = normalizeWorkLocationToTenantCode(code);
    if (mapped) out.add(mapped);
  }
  const home = normalizeWorkLocationToTenantCode(homeTenantCode);
  if (home) out.add(home);
  return [...out].sort();
}
