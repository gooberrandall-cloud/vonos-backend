import type { Role } from "./role";
import { isHrRoleName } from "./tenantRole";

/**
 * How much of the HRM module a user may see.
 *
 * - `full`       — the whole HRM module (dashboard, leave, attendance,
 *                  HR & People, settings, all payroll).
 *                  Granted to: Admin / super_admin ("boss"), HR roles and
 *                  Accountant roles ("HR accountant"), and any role holding
 *                  the `*` master permission.
 * - `own-payroll`— no HRM module at all except the user's own payslips
 *                  (`/hrm/my-payrolls`), read-only.
 *
 * Note: self-service `essentials.*` permissions (own leave/attendance,
 * messages) do NOT grant full access — otherwise every staff member would
 * see everyone's payroll.
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

/**
 * `essentials.*` keys that are *self-service* — they let a staff member manage
 * only their own leave/attendance/messages and must NOT unlock the whole HRM
 * module (everyone's payroll). Anything else under `essentials.*` is a
 * management capability and grants full HRM access.
 */
const SELF_SERVICE_ESSENTIALS = new Set([
  "essentials.crud_own_leave",
  "essentials.view_own_attendance",
  "essentials.view_message",
  "essentials.create_message",
  "essentials.view_allowance_and_deduction",
]);

/** True when a granted permission key grants HRM management access. */
export function hasHrmEssentialsPermission(
  permissions: string[] | null | undefined,
): boolean {
  if (!permissions || permissions.length === 0) return false;
  if (permissions.includes("*")) return true;
  return permissions.some(
    (key) =>
      key.startsWith("essentials.") && !SELF_SERVICE_ESSENTIALS.has(key),
  );
}

/**
 * Single source of truth for HRM visibility — used by both the NestJS
 * `HrmAccessGuard` and the web `useHrmAccess` hook so the two layers can
 * never disagree.
 */
export function resolveHrmAccess(input: HrmAccessInput): HrmAccessLevel {
  if (input.role === "super_admin" || input.role === "admin") return "full";

  // Master wildcard ("all permissions") — effectively a superuser.
  if (input.tenantRolePermissions?.includes("*")) return "full";

  const name = input.tenantRoleName?.trim();
  if (name) {
    const lower = name.toLowerCase();
    // Locked / built-in Admin TenantRole.
    if (lower === "admin") return "full";
    // Only HR and Accountant roles may see the whole HRM module (all payroll).
    if (isHrRoleName(name) || isAccountantRoleName(name)) return "full";
  }

  return "own-payroll";
}

/** Convenience: `true` when the user may see the whole HRM module. */
export function hasFullHrmAccess(input: HrmAccessInput): boolean {
  return resolveHrmAccess(input) === "full";
}
