import type { Role } from "./role";
import { isHrRoleName } from "./tenantRole";

/**
 * How much of the HRM module a user may see.
 *
 * - `full`       — the whole HRM module (dashboard, leave, attendance,
 *                  HR & People, settings, all payroll).
 *                  Granted to: Admin / super_admin ("boss"), HR roles and
 *                  Accountant roles ("HR accountant"), or any role ticked
 *                  with an `essentials.*` HRM checkbox.
 * - `own-payroll`— no HRM module at all except the user's own payslips
 *                  (`/hrm/my-payrolls`), read-only.
 */
export type HrmAccessLevel = "full" | "own-payroll";

export interface HrmAccessInput {
  role?: Role | null | undefined;
  tenantRoleName?: string | null | undefined;
  tenantRolePermissions?: string[] | null | undefined;
}

/** True when `name` looks like an Accountant job role (e.g. ACCOUNTANT). */
export function isAccountantRoleName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n || n === "admin") return false;
  return n.includes("accountant");
}

/** True when any granted permission key belongs to the HRM Essentials module. */
export function hasHrmEssentialsPermission(
  permissions: string[] | null | undefined,
): boolean {
  if (!permissions || permissions.length === 0) return false;
  if (permissions.includes("*")) return true;
  return permissions.some((key) => key.startsWith("essentials."));
}

/**
 * Single source of truth for HRM visibility — used by both the NestJS
 * `HrmAccessGuard` and the web `useHrmAccess` hook so the two layers can
 * never disagree.
 */
export function resolveHrmAccess(input: HrmAccessInput): HrmAccessLevel {
  if (input.role === "super_admin" || input.role === "admin") return "full";

  const name = input.tenantRoleName?.trim();
  if (name) {
    const lower = name.toLowerCase();
    // Locked / built-in Admin TenantRole.
    if (lower === "admin") return "full";
    if (isHrRoleName(name) || isAccountantRoleName(name)) return "full";
  }

  if (hasHrmEssentialsPermission(input.tenantRolePermissions)) return "full";

  return "own-payroll";
}

/** Convenience: `true` when the user may see the whole HRM module. */
export function hasFullHrmAccess(input: HrmAccessInput): boolean {
  return resolveHrmAccess(input) === "full";
}
