import {
  hasHrmEssentialsPermission,
  isAccountantRoleName,
  resolveHrmAccess,
} from '@vonos/types';

describe('resolveHrmAccess', () => {
  it('grants full access to super_admin and admin (the boss)', () => {
    expect(resolveHrmAccess({ role: 'super_admin' })).toBe('full');
    expect(resolveHrmAccess({ role: 'admin' })).toBe('full');
  });

  it('grants full access to the locked Admin TenantRole', () => {
    expect(resolveHrmAccess({ role: 'staff', tenantRoleName: 'Admin' })).toBe(
      'full',
    );
  });

  it('grants full access to HR role names', () => {
    expect(
      resolveHrmAccess({
        role: 'admin',
        tenantRoleName: 'HR & OPERATIONS MANAGER',
      }),
    ).toBe('full');
    expect(resolveHrmAccess({ role: 'staff', tenantRoleName: 'HR' })).toBe(
      'full',
    );
    expect(
      resolveHrmAccess({ role: 'staff', tenantRoleName: 'Human Resources' }),
    ).toBe('full');
  });

  it('grants full access to Accountant role names', () => {
    expect(
      resolveHrmAccess({ role: 'staff', tenantRoleName: 'ACCOUNTANT' }),
    ).toBe('full');
    expect(
      resolveHrmAccess({ role: 'staff', tenantRoleName: 'Senior Accountant' }),
    ).toBe('full');
  });

  it('grants full access when an essentials.* HRM checkbox is ticked', () => {
    expect(
      resolveHrmAccess({
        role: 'staff',
        tenantRoleName: 'MANAGER',
        tenantRolePermissions: ['product.view', 'essentials.view_all_payroll'],
      }),
    ).toBe('full');
    expect(
      resolveHrmAccess({
        role: 'viewer',
        tenantRoleName: 'CLEANER',
        tenantRolePermissions: ['*'],
      }),
    ).toBe('full');
  });

  it('restricts everyone else to their own payrolls', () => {
    expect(resolveHrmAccess({ role: 'staff' })).toBe('own-payroll');
    expect(resolveHrmAccess({ role: 'viewer' })).toBe('own-payroll');
    expect(resolveHrmAccess({ role: 'manager' })).toBe('own-payroll');
    expect(
      resolveHrmAccess({
        role: 'staff',
        tenantRoleName: 'MANAGER',
        tenantRolePermissions: ['product.view', 'direct_sell.view'],
      }),
    ).toBe('own-payroll');
    expect(
      resolveHrmAccess({
        role: 'staff',
        tenantRoleName: 'AUTO-MECHANIC',
        tenantRolePermissions: ['app.jobs.view'],
      }),
    ).toBe('own-payroll');
  });

  it('never treats finance or user permissions as HRM access', () => {
    expect(
      resolveHrmAccess({
        role: 'staff',
        tenantRoleName: 'ACCOUNTING CLERK',
        tenantRolePermissions: ['app.finance.view', 'user.view'],
      }),
    ).toBe('own-payroll');
  });
});

describe('isAccountantRoleName', () => {
  it('matches accountant names only', () => {
    expect(isAccountantRoleName('ACCOUNTANT')).toBe(true);
    expect(isAccountantRoleName('Senior Accountant')).toBe(true);
    expect(isAccountantRoleName('MANAGER')).toBe(false);
    expect(isAccountantRoleName('ACCOUNTING CLERK')).toBe(false);
    expect(isAccountantRoleName('admin')).toBe(false);
    expect(isAccountantRoleName('')).toBe(false);
  });
});

describe('hasHrmEssentialsPermission', () => {
  it('matches wildcard and essentials.* keys', () => {
    expect(hasHrmEssentialsPermission(['*'])).toBe(true);
    expect(hasHrmEssentialsPermission(['essentials.crud_leave'])).toBe(true);
    expect(hasHrmEssentialsPermission(['user.view'])).toBe(false);
    expect(hasHrmEssentialsPermission([])).toBe(false);
    expect(hasHrmEssentialsPermission(null)).toBe(false);
  });
});
