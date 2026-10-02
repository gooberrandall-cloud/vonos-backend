/** Stable tenant ids — matches Prisma seed / TENANT_REGISTRY on web. */
const TENANT_CODE_TO_ID: Record<string, string> = {
  VW: 'tenant_vw_001',
  VKW: 'tenant_vkw_001',
  VISP: 'tenant_visp_001',
  VSP: 'tenant_vsp_001',
  VC: 'tenant_vc_001',
  VA: 'tenant_va_001',
  VP: 'tenant_vp_001',
  VS: 'tenant_vs_001',
  VAG: 'tenant_vag_001',
};

export function tenantIdsForCodes(codes: readonly string[]): string[] {
  const ids: string[] = [];
  for (const code of codes) {
    const id = TENANT_CODE_TO_ID[code];
    if (id) ids.push(id);
  }
  return ids;
}

export function isClearanceTenantId(
  tenantId: string,
  allowedCodes: readonly string[],
): boolean {
  if (!allowedCodes.length) return false;
  const allowedIds = tenantIdsForCodes(allowedCodes);
  return allowedIds.includes(tenantId);
}
