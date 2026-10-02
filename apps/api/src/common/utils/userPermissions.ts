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
