import type { CreateEmployeeRequest } from '@vonos/types';

type EmployeeRow = {
  name: string;
  employeeCode: string | null;
  locationCode: string | null;
  locationCodes: string[] | null;
  payrollGroupId: string | null;
  designationId: string;
  accountHolderName: string | null;
  bankName: string | null;
  bankBranch: string | null;
  bankCode: string | null;
  bankAccountNo: string | null;
  taxPayerId: string | null;
  mobile: string | null;
  altContact: string | null;
  familyContact: string | null;
  guardianName: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  maritalStatus: string | null;
  bloodGroup: string | null;
  idProofName: string | null;
  idProofNumber: string | null;
  permanentAddress: string | null;
  currentAddress: string | null;
  salesCommission: unknown;
  maxSalesDiscountPercent: unknown;
  department: string | null;
};

export const BANK_FIELDS = [
  'accountHolderName',
  'bankName',
  'bankBranch',
  'bankCode',
  'bankAccountNo',
  'taxPayerId',
] as const;

const TEXT_FIELDS = [
  'accountHolderName',
  'bankName',
  'bankBranch',
  'bankCode',
  'bankAccountNo',
  'taxPayerId',
  'mobile',
  'altContact',
  'familyContact',
  'guardianName',
  'gender',
  'maritalStatus',
  'bloodGroup',
  'idProofName',
  'idProofNumber',
  'permanentAddress',
  'currentAddress',
  'department',
] as const;

function trimmed(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

/**
 * Data for updating an employee row that already exists for a user.
 *
 * Fill-only semantics: a non-empty value from the caller wins, an empty or
 * absent value keeps whatever is on the row. The user create/invite flow
 * re-runs `createEmployee` for users who already have a row (created earlier
 * by roster sync); merging instead of inserting stops duplicate rows — the
 * cause of bank details landing on one copy while payrolls point at another
 * ("I entered the account number but it was lost").
 */
export function employeeMergeData(
  existing: EmployeeRow,
  dto: CreateEmployeeRequest,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  const name = trimmed(dto.name);
  if (name && name !== existing.name) {
    data.name = name;
  }

  const designationId = dto.designationId?.trim();
  if (designationId && designationId !== existing.designationId) {
    data.designationId = designationId;
  }

  const employeeCode = trimmed(dto.employeeCode);
  if (employeeCode && employeeCode !== existing.employeeCode) {
    data.employeeCode = employeeCode;
  }

  const payrollGroupId = trimmed(dto.payrollGroupId);
  if (payrollGroupId && payrollGroupId !== existing.payrollGroupId) {
    data.payrollGroupId = payrollGroupId;
  }

  if (dto.isServiceStaff !== undefined) {
    data.isServiceStaff = dto.isServiceStaff;
  }

  for (const field of TEXT_FIELDS) {
    const next = trimmed(dto[field]);
    if (next && next !== existing[field]) {
      data[field] = next;
    }
  }

  const dateOfBirth = dto.dateOfBirth?.trim()
    ? new Date(`${dto.dateOfBirth.trim().slice(0, 10)}T00:00:00.000Z`)
    : null;
  if (dateOfBirth && !Number.isNaN(dateOfBirth.getTime())) {
    data.dateOfBirth = dateOfBirth;
  }

  if (
    typeof dto.salesCommission === 'number' &&
    Number.isFinite(dto.salesCommission)
  ) {
    data.salesCommission = dto.salesCommission;
  }
  if (
    typeof dto.maxSalesDiscountPercent === 'number' &&
    Number.isFinite(dto.maxSalesDiscountPercent)
  ) {
    data.maxSalesDiscountPercent = dto.maxSalesDiscountPercent;
  }

  const locationCodes = (dto.locationCodes ?? [])
    .map((code) => code.trim())
    .filter(Boolean);
  if (locationCodes.length === 0 && dto.locationCode?.trim()) {
    locationCodes.push(dto.locationCode.trim());
  }
  const sameLocations =
    existing.locationCodes != null &&
    existing.locationCodes.length === locationCodes.length &&
    locationCodes.every((code, i) => existing.locationCodes?.[i] === code);
  if (locationCodes.length > 0 && !sameLocations) {
    data.locationCodes = locationCodes;
    data.locationCode = locationCodes[0];
  }

  return data;
}

/**
 * Fill-only patch that copies non-empty bank fields from a source employee
 * row onto a sibling row of the same user (other tenant / duplicate row).
 * Blank target fields get the value; populated ones are left alone.
 */
export function fillMissingBankFields(
  source: Record<(typeof BANK_FIELDS)[number], string | null | undefined>,
  target: Record<(typeof BANK_FIELDS)[number], string | null | undefined>,
): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const field of BANK_FIELDS) {
    const next = trimmed(source[field]);
    const current = trimmed(target[field]);
    if (next && !current) patch[field] = next;
  }
  return patch;
}
