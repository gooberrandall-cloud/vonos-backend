import { userHasAnyPermission, userHasPermission } from './userPermissions';
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

describe('userHasAnyPermission', () => {
  const ADJUST_KEYS = ['product.opening_stock', 'purchase.update'] as const;

  it('allows JWT admin and super_admin regardless of matrix', () => {
    expect(
      userHasAnyPermission(user({ role: 'admin' }), ADJUST_KEYS),
    ).toBe(true);
    expect(
      userHasAnyPermission(user({ role: 'super_admin' }), ADJUST_KEYS),
    ).toBe(true);
  });

  it('allows a procurement-style role holding only purchase.update', () => {
    expect(
      userHasAnyPermission(
        user({
          role: 'manager',
          tenantRolePermissions: ['purchase.view', 'purchase.update'],
        }),
        ADJUST_KEYS,
      ),
    ).toBe(true);
  });

  it('allows a stock-style role holding only product.opening_stock', () => {
    expect(
      userHasAnyPermission(
        user({
          role: 'staff',
          tenantRolePermissions: ['product.opening_stock'],
        }),
        ADJUST_KEYS,
      ),
    ).toBe(true);
  });

  it('denies roles holding neither key', () => {
    expect(
      userHasAnyPermission(
        user({
          role: 'manager',
          tenantRolePermissions: ['purchase.view', 'product.view'],
        }),
        ADJUST_KEYS,
      ),
    ).toBe(false);
  });
});
