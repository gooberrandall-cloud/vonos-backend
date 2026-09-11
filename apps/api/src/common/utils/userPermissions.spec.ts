import { userHasPermission } from './userPermissions';
import type { AuthenticatedUser } from '../decorators/roles.decorator';

function user(
  partial: Partial<AuthenticatedUser> & Pick<AuthenticatedUser, 'role'>,
): AuthenticatedUser {
  return {
    sub: 'u1',
    tenantId: 't1',
    tenantRolePermissions: null,
    ...partial,
  };
}

describe('userHasPermission', () => {
  it('allows JWT admin and super_admin even with empty matrix', () => {
    expect(
      userHasPermission(user({ role: 'admin' }), 'roles.update'),
    ).toBe(true);
    expect(
      userHasPermission(user({ role: 'super_admin' }), 'roles.update'),
    ).toBe(true);
  });

  it('allows * or exact key for staff/manager', () => {
    expect(
      userHasPermission(
        user({ role: 'manager', tenantRolePermissions: ['*'] }),
        'roles.update',
      ),
    ).toBe(true);
    expect(
      userHasPermission(
        user({
          role: 'manager',
          tenantRolePermissions: ['roles.update', 'product.opening_stock'],
        }),
        'roles.update',
      ),
    ).toBe(true);
    expect(
      userHasPermission(
        user({
          role: 'manager',
          tenantRolePermissions: ['product.opening_stock'],
        }),
        'roles.update',
      ),
    ).toBe(false);
  });
});
