import { describe, expect, it } from 'vitest';
import {
  resolvePayrollStaffBucket,
  isManagementStaffLabel,
  isTechnicalStaffLabel,
} from './payrollStaffBuckets';

describe('payrollStaffBuckets', () => {
  it('classifies management before service', () => {
    expect(
      resolvePayrollStaffBucket({
        roleName: 'saloon manager',
        isServiceStaff: true,
      }),
    ).toBe('management');
    expect(isManagementStaffLabel('HR & OPERATIONS MANAGER')).toBe(true);
  });

  it('classifies technical workshop roles', () => {
    expect(isTechnicalStaffLabel('AUTO-MECHANIC')).toBe(true);
    expect(
      resolvePayrollStaffBucket({
        designation: 'AUTO-ELECTRICIAN',
        roleIsServiceStaff: true,
      }),
    ).toBe('technical');
  });

  it('classifies service staff from flag', () => {
    expect(
      resolvePayrollStaffBucket({
        designation: 'Staff',
        isServiceStaff: true,
      }),
    ).toBe('service');
  });

  it('falls back to other', () => {
    expect(
      resolvePayrollStaffBucket({
        designation: 'Staff',
        department: null,
      }),
    ).toBe('other');
  });
});
