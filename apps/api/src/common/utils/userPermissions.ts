import type { AuthenticatedUser } from '../decorators/roles.decorator';

/**
 * Match web `useAppPermissions`: Admin / VAG JWT get full access; otherwise
 * the assigned TenantRole matrix (`*` or exact key) must include the key.
 *
 * Without this, JWT admin / super_admin with empty `tenantRolePermissions`
 * can edit the Roles UI but PATCH fails with "Missing roles.update".
 */
export function userHasPermission(
  user: AuthenticatedUser,
  key: string,
): boolean {
  if (user.role === 'admin' || user.role === 'super_admin') return true;
  const perms = user.tenantRolePermissions ?? [];
  return perms.includes('*') || perms.includes(key);
}

/**
 * Any-of variant: passes when the matrix includes at least one of the keys.
 * Used where two permission families legitimately cover one action (e.g.
 * Adjust Stock is reachable via product "Add Opening Stock" or the purchase
 * "Edit purchase & Stock Adjustment" checkbox).
 */
export function userHasAnyPermission(
  user: AuthenticatedUser,
  keys: readonly string[],
): boolean {
  if (user.role === 'admin' || user.role === 'super_admin') return true;
  const perms = user.tenantRolePermissions ?? [];
  if (perms.includes('*')) return true;
  return keys.some((key) => perms.includes(key));
}

/** Payroll writes: JWT manager+ or TenantRole essentials.* keys (HR staff). */
export function userCanHrmPayrollWrite(
  user: AuthenticatedUser,
  permissionKey: string,
): boolean {
  if (
    user.role === 'admin' ||
    user.role === 'super_admin' ||
    user.role === 'manager'
  ) {
    return true;
  }
  return userHasPermission(user, permissionKey);
}
