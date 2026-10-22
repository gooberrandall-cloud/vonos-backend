import type { CreateEmployeeRequest } from '@vonos/types';
import { employeeMergeData, fillMissingBankFields } from './employeeMerge';

function existingRow() {
  return {
    name: 'Ruth Sule',
    employeeCode: null,
    locationCode: 'VW',
    locationCodes: ['VW'],
    payrollGroupId: null,
    designationId: 'd1',
    accountHolderName: null,
    bankName: 'OPAY',
    bankBranch: null,
    bankCode: null,
    bankAccountNo: '8143453178',
    taxPayerId: null,
    mobile: null,
    altContact: null,
    familyContact: null,
    guardianName: null,
    dateOfBirth: null,
    gender: null,
    maritalStatus: null,
    bloodGroup: null,
    idProofName: null,
    idProofNumber: null,
    permanentAddress: null,
    currentAddress: null,
    salesCommission: 0,
    maxSalesDiscountPercent: null,
    department: null,
  };
}

function dto(
  overrides: Partial<CreateEmployeeRequest> = {},
): CreateEmployeeRequest {
  return {
    name: 'Ruth Sule',
    designationId: 'd1',
    userId: 'u1',
    locationCodes: ['VW'],
    ...overrides,
  };
}

describe('employeeMergeData', () => {
  it('fills missing bank fields from the caller without wiping existing values', () => {
    const data = employeeMergeData(
      existingRow(),
      dto({
        accountHolderName: 'Sule Ruth',
        bankAccountNo: '', // form left blank — keep what is on the row
        bankName: undefined,
        mobile: '08012345678',
      }),
    );

    expect(data.accountHolderName).toBe('Sule Ruth');
    expect(data.mobile).toBe('08012345678');
    expect('bankAccountNo' in data).toBe(false);
    expect('bankName' in data).toBe(false);
  });

  it('never clears a populated bank field with an empty value', () => {
    const data = employeeMergeData(
      existingRow(),
      dto({
        bankAccountNo: '   ',
        bankName: null,
      }),
    );
    expect('bankAccountNo' in data).toBe(false);
    expect('bankName' in data).toBe(false);
  });

  it('updates designation, locations and name when provided', () => {
    const data = employeeMergeData(
      existingRow(),
      dto({
        name: '  Miss Ruth Sule ',
        designationId: 'd2',
        locationCodes: ['VW', 'VS'],
      }),
    );
    expect(data.name).toBe('Miss Ruth Sule');
    expect(data.designationId).toBe('d2');
    expect(data.locationCodes).toEqual(['VW', 'VS']);
    expect(data.locationCode).toBe('VW');
  });

  it('falls back to locationCode when locationCodes is absent', () => {
    const data = employeeMergeData(
      existingRow(),
      dto({
        locationCodes: undefined,
        locationCode: ' VS ',
      }),
    );
    expect(data.locationCodes).toEqual(['VS']);
    expect(data.locationCode).toBe('VS');
  });

  it('keeps numeric profile fields only when valid numbers are provided', () => {
    const data = employeeMergeData(
      existingRow(),
      dto({
        salesCommission: 5,
        maxSalesDiscountPercent: null,
      }),
    );
    expect(data.salesCommission).toBe(5);
    expect('maxSalesDiscountPercent' in data).toBe(false);
  });

  it('produces no changes when the payload adds nothing', () => {
    const data = employeeMergeData(
      existingRow(),
      dto({
        name: 'Ruth Sule',
        designationId: 'd1',
        locationCodes: ['VW'],
      }),
    );
    expect(Object.keys(data)).toEqual([]);
  });
});

describe('fillMissingBankFields', () => {
  const source = {
    accountHolderName: 'Joel Joseph',
    bankName: 'UBA',
    bankBranch: null,
    bankCode: null,
    bankAccountNo: '2143537094',
    taxPayerId: null,
  };

  it('fills only blank fields and never overwrites populated ones', () => {
    const patch = fillMissingBankFields(source, {
      accountHolderName: null,
      bankName: 'GTB', // already has a bank — keep it
      bankBranch: '  ',
      bankCode: null,
      bankAccountNo: '',
      taxPayerId: null,
    });
    expect(patch).toEqual({
      accountHolderName: 'Joel Joseph',
      bankAccountNo: '2143537094',
    });
  });

  it('returns an empty patch when the target already has everything', () => {
    expect(fillMissingBankFields(source, source)).toEqual({});
  });
});
