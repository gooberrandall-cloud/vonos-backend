/**
 * Vonos Group (VAG) membership vs operations-only entities.
 *
 * Autos group codes (warehouse / mechanic / painting / spare-parts) drive
 * autos-scoped APIs (e.g. stock availability). Admin overview / finance /
 * reports roll-ups use `VAG_OVERVIEW_CODES`, which also includes Cafe (VC).
 * Saloon and Kids Wear stay operations-only mounts.
 */
export const AUTOS_GROUP_CODES = [
  "VW",
  "VA",
  "VP",
  "VISP",
  "VSP",
] as const;

/**
 * Tenants shown on VAG admin overview, group finance, and group reports.
 * Includes Cafe (VC) sales; does not fold VC into `AUTOS_GROUP_CODES`.
 */
export const VAG_OVERVIEW_CODES = [...AUTOS_GROUP_CODES, "VC"] as const;

/** Cafe / Saloon / Kids Wear — own workspaces under `/operations/{CODE}`. */
export const OPERATIONS_GROUP_CODES = ["VC", "VS", "VKW"] as const;

export type AutosGroupCode = (typeof AUTOS_GROUP_CODES)[number];
export type VagOverviewCode = (typeof VAG_OVERVIEW_CODES)[number];
export type OperationsGroupCode = (typeof OPERATIONS_GROUP_CODES)[number];

export function isAutosGroupCode(code: string | null | undefined): boolean {
  return code != null && (AUTOS_GROUP_CODES as readonly string[]).includes(code);
}

export function isVagOverviewCode(code: string | null | undefined): boolean {
  return (
    code != null && (VAG_OVERVIEW_CODES as readonly string[]).includes(code)
  );
}

export function isOperationsGroupCode(
  code: string | null | undefined,
): boolean {
  return (
    code != null &&
    (OPERATIONS_GROUP_CODES as readonly string[]).includes(code)
  );
}
