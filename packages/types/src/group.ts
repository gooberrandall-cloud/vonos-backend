/**
 * Vonos Autos Group (VAG) membership.
 *
 * Only auto-related entities roll up into the group admin surfaces
 * (group overview, entity switcher, invites, group finance/reports).
 * Non-auto entities (Cafe, Saloon, Kids Wear) stay in the system and
 * remain fully usable when logged in directly — they are simply hidden
 * from the group.
 */
export const AUTOS_GROUP_CODES = ["VW", "VA", "VISP", "VSP"] as const;

export type AutosGroupCode = (typeof AUTOS_GROUP_CODES)[number];

export function isAutosGroupCode(code: string | null | undefined): boolean {
  return code != null && (AUTOS_GROUP_CODES as readonly string[]).includes(code);
}
