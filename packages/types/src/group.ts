/**
 * Vonos Group (VAG) membership vs operations-only entities.
 *
 * Autos group roll-ups (overview, finance, reports, invites) include
 * warehouse / mechanic / painting / spare-parts entities only.
 * Cafe, Saloon, and Kids Wear are separate operations mounts — not in VAG.
 */
export const AUTOS_GROUP_CODES = [
  "VW",
  "VA",
  "VP",
  "VISP",
  "VSP",
] as const;

/** Cafe / Saloon / Kids Wear — own workspaces under `/operations/{CODE}`. */
export const OPERATIONS_GROUP_CODES = ["VC", "VS", "VKW"] as const;

export type AutosGroupCode = (typeof AUTOS_GROUP_CODES)[number];
export type OperationsGroupCode = (typeof OPERATIONS_GROUP_CODES)[number];

export function isAutosGroupCode(code: string | null | undefined): boolean {
  return code != null && (AUTOS_GROUP_CODES as readonly string[]).includes(code);
}

export function isOperationsGroupCode(
  code: string | null | undefined,
): boolean {
  return (
    code != null &&
    (OPERATIONS_GROUP_CODES as readonly string[]).includes(code)
  );
}
