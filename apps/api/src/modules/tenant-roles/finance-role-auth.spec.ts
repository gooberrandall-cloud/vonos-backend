import {
  FINANCE_ACCESS_PERMISSION_KEYS,
  FINANCE_ROLE_DEFAULT_PERMISSIONS,
  isFinanceAuthorizedRoleName,
  isFinancePermissionKey,
  isHrRoleName,
} from '@vonos/types';

describe('finance role authorization helpers', () => {
  it('auto-grants finance only to accountant role names', () => {
    expect(isFinanceAuthorizedRoleName('ACCOUNTANT')).toBe(true);
    expect(isFinanceAuthorizedRoleName('Senior Accountant')).toBe(true);
    expect(isFinanceAuthorizedRoleName('MANAGER')).toBe(false);
    expect(isFinanceAuthorizedRoleName('Assistant Manager')).toBe(false);
    expect(isFinanceAuthorizedRoleName('Stock Keeper')).toBe(false);
    expect(isFinanceAuthorizedRoleName('PARTS MANAGEMENT')).toBe(false);
    expect(isFinanceAuthorizedRoleName('PARTS AUDITOR')).toBe(false);
  });

  it('does not grant finance via HR or frontline role names', () => {
    expect(isHrRoleName('HR & OPERATIONS MANAGER')).toBe(true);
    expect(isFinanceAuthorizedRoleName('HR & OPERATIONS MANAGER')).toBe(false);
    expect(isFinanceAuthorizedRoleName('HR')).toBe(false);
    expect(isFinanceAuthorizedRoleName('FRONT DESK')).toBe(false);
    expect(isFinanceAuthorizedRoleName('Service Staff')).toBe(false);
    expect(isFinanceAuthorizedRoleName('SOCIAL MEDIA MANAGER')).toBe(false);
  });

  it('marks finance access keys correctly', () => {
    for (const key of FINANCE_ACCESS_PERMISSION_KEYS) {
      expect(isFinancePermissionKey(key)).toBe(true);
    }
    expect(isFinancePermissionKey('view_purchase_price')).toBe(true);
    expect(isFinancePermissionKey('product.view')).toBe(false);
    expect(FINANCE_ROLE_DEFAULT_PERMISSIONS).toEqual(
      expect.arrayContaining([...FINANCE_ACCESS_PERMISSION_KEYS]),
    );
  });
});
