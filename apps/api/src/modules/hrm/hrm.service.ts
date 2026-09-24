import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type {
  PayComponent,
  Payroll,
  PayrollGroup,
  PayrollGroupDetail,
  PayrollGroupStatus,
  PayrollPaymentRow,
  Designation,
  Employee,
  PayrollCandidate,
  WorkforceMember,
  CreatePayrollRequest,
  CreatePayrollGroupRequest,
  CreatePayComponentRequest,
  CreateDesignationRequest,
  CreateEmployeeRequest,
  SyncEmployeeByUserRequest,
  UpdatePayrollDeductionRequest,
  UpdatePayrollStatusRequest,
  UpdatePayrollGroupPayrollsRequest,
  UpdatePayComponentRequest,
  PayPayrollsRequest,
  PayPayrollsResult,
  PayrollFilters,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { resolveListSort } from '../../common/utils/listSort';
import { toIso, toNumber } from '../../common/utils/serializers';
import { isServiceStaffEligible } from '../../common/utils/serviceStaffDesignations';
import { resolvePayrollStaffBucket } from '../../common/utils/payrollStaffBuckets';
import {
  recordPaymentAccountTxn,
  softDeleteExpenseAccountTxns,
  softDeletePaymentAccountTxns,
} from '../../common/utils/recordPaymentAccountTxn';
import { applyDailyFinanceDelta } from '../../common/utils/dailyFinanceRollup';
import { InvoiceHubService } from '../invoices/invoice-hub.service';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';

function optionalTrim(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalDate(
  value: string | null | undefined,
): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || !value.trim()) return null;
  const raw = value.trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function optionalNumber(
  value: number | null | undefined,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return Number.isFinite(value) ? value : null;
}

function employeeProfileCreateData(dto: CreateEmployeeRequest) {
  return {
    mobile: optionalTrim(dto.mobile) ?? null,
    altContact: optionalTrim(dto.altContact) ?? null,
    familyContact: optionalTrim(dto.familyContact) ?? null,
    guardianName: optionalTrim(dto.guardianName) ?? null,
    dateOfBirth: parseOptionalDate(dto.dateOfBirth) ?? null,
    gender: optionalTrim(dto.gender) ?? null,
    maritalStatus: optionalTrim(dto.maritalStatus) ?? null,
    bloodGroup: optionalTrim(dto.bloodGroup) ?? null,
    idProofName: optionalTrim(dto.idProofName) ?? null,
    idProofNumber: optionalTrim(dto.idProofNumber) ?? null,
    permanentAddress: optionalTrim(dto.permanentAddress) ?? null,
    currentAddress: optionalTrim(dto.currentAddress) ?? null,
    salesCommission: optionalNumber(dto.salesCommission) ?? 0,
    maxSalesDiscountPercent: optionalNumber(dto.maxSalesDiscountPercent) ?? null,
    department: optionalTrim(dto.department) ?? null,
  };
}

function employeeProfilePatchData(args: SyncEmployeeByUserRequest) {
  const patch: Record<string, unknown> = {};
  const setTrim = (key: string, value: string | null | undefined) => {
    if (value === undefined) return;
    patch[key] = optionalTrim(value) ?? null;
  };
  setTrim('accountHolderName', args.accountHolderName);
  setTrim('bankName', args.bankName);
  setTrim('bankBranch', args.bankBranch);
  setTrim('bankCode', args.bankCode);
  setTrim('bankAccountNo', args.bankAccountNo);
  setTrim('taxPayerId', args.taxPayerId);
  setTrim('mobile', args.mobile);
  setTrim('altContact', args.altContact);
  setTrim('familyContact', args.familyContact);
  setTrim('guardianName', args.guardianName);
  setTrim('gender', args.gender);
  setTrim('maritalStatus', args.maritalStatus);
  setTrim('bloodGroup', args.bloodGroup);
  setTrim('idProofName', args.idProofName);
  setTrim('idProofNumber', args.idProofNumber);
  setTrim('permanentAddress', args.permanentAddress);
  setTrim('currentAddress', args.currentAddress);
  setTrim('department', args.department);
  if (args.dateOfBirth !== undefined) {
    patch.dateOfBirth = parseOptionalDate(args.dateOfBirth) ?? null;
  }
  if (args.salesCommission !== undefined) {
    patch.salesCommission = optionalNumber(args.salesCommission) ?? 0;
  }
  if (args.maxSalesDiscountPercent !== undefined) {
    patch.maxSalesDiscountPercent =
      optionalNumber(args.maxSalesDiscountPercent) ?? null;
  }
  if (args.designationId?.trim()) {
    patch.designationId = args.designationId.trim();
  }
  return patch;
}

const PAYROLL_INCLUDE = {
  payrollGroup: true,
  designation: { select: { name: true } },
  employeeRecord: {
    select: {
      accountHolderName: true,
      bankName: true,
      bankBranch: true,
      bankCode: true,
      bankAccountNo: true,
      taxPayerId: true,
      department: true,
    },
  },
  invoice: { select: { reference: true } },
  tenant: { select: { code: true, name: true } },
} as const;

function aggregateGroupPaymentStatus(
  payrolls: { paymentStatus: string }[],
): 'due' | 'partial' | 'paid' {
  if (payrolls.length === 0) return 'due';
  const paidCount = payrolls.filter((p) => p.paymentStatus === 'paid').length;
  if (paidCount === payrolls.length) return 'paid';
  if (paidCount === 0) return 'due';
  return 'partial';
}

@Injectable()
export class HrmService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly invoiceHub: InvoiceHubService,
    private readonly auditService: AuditService,
    private readonly cache: CacheService,
  ) {}

  async listWorkforce(
    filters: {
      search?: string;
      cursor?: string;
      limit?: number;
      includeSummary?: boolean;
    } = {},
  ): Promise<{
    items: WorkforceMember[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const includeSummary = filters.includeSummary !== false;
    const cacheKey = await this.cache.tenantScopedKey(
      tenantId,
      `workforce:list:${filters.search ?? ''}:${filters.cursor ?? ''}:${filters.limit ?? ''}:${includeSummary ? 1 : 0}`,
    );
    const cached = await this.cache.get<{
      items: WorkforceMember[];
      totalCount?: number;
      hasMore?: boolean;
    }>(cacheKey);
    if (cached) return cached;

    const result = await this.queryWorkforce({
      tenantId,
      search: filters.search,
      cursor: filters.cursor,
      limit: filters.limit,
      includeSummary,
    });
    await this.cache.set(cacheKey, result, 900);
    return result;
  }

  async listWorkforceAllTenants(
    requestRole: string,
    filters: {
      search?: string;
      cursor?: string;
      limit?: number;
      includeSummary?: boolean;
    } = {},
  ): Promise<{
    items: WorkforceMember[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    if (requestRole !== 'super_admin') {
      throw new ForbiddenException('Super admin access required');
    }
    return this.queryWorkforce({
      search: filters.search,
      cursor: filters.cursor,
      limit: filters.limit,
      includeSummary: filters.includeSummary !== false,
    });
  }

  /** Accurate dashboard counts (not page-length). */
  async getWorkforceStats(): Promise<{
    totalCount: number;
    byLocation: Array<{ locationCode: string | null; count: number }>;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const cacheKey = await this.cache.tenantScopedKey(
      tenantId,
      'workforce:stats',
    );
    const cached = await this.cache.get<{
      totalCount: number;
      byLocation: Array<{ locationCode: string | null; count: number }>;
    }>(cacheKey);
    if (cached) return cached;

    const where = { tenantId, deletedAt: null as null };
    const employeeCount = await this.tenantDb.db.employee.count({ where });
    if (employeeCount > 0) {
      const grouped = await this.tenantDb.db.employee.groupBy({
        by: ['locationCode'],
        where,
        _count: { _all: true },
        orderBy: { locationCode: 'asc' },
      });
      const result = {
        totalCount: employeeCount,
        byLocation: grouped.map((row) => ({
          locationCode: row.locationCode,
          count: row._count._all,
        })),
      };
      await this.cache.set(cacheKey, result, 900);
      return result;
    }

    // Fallback when only payroll-derived roster exists
    const distinct = await this.tenantDb.db.$queryRawUnsafe<
      Array<{ locationCode: string | null; count: bigint }>
    >(
      `
      SELECT "locationCode", COUNT(*)::bigint AS count
      FROM (
        SELECT DISTINCT ON (COALESCE(NULLIF(TRIM("employeeId"), ''), LOWER(TRIM("employeeName"))))
          "locationCode"
        FROM "Payroll"
        WHERE "tenantId" = $1
          AND "deletedAt" IS NULL
          AND "employeeName" IS NOT NULL
          AND TRIM("employeeName") <> ''
        ORDER BY COALESCE(NULLIF(TRIM("employeeId"), ''), LOWER(TRIM("employeeName"))),
                 "createdAt" DESC
      ) roster
      GROUP BY "locationCode"
      ORDER BY "locationCode" ASC NULLS LAST
      `,
      tenantId,
    );
    const result = {
      totalCount: distinct.reduce((sum, row) => sum + Number(row.count), 0),
      byLocation: distinct.map((row) => ({
        locationCode: row.locationCode,
        count: Number(row.count),
      })),
    };
    await this.cache.set(cacheKey, result, 900);
    return result;
  }

  private async queryWorkforce(options: {
    tenantId?: string;
    search?: string;
    cursor?: string;
    limit?: number;
    includeSummary?: boolean;
  }): Promise<{
    items: WorkforceMember[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: options.cursor,
      limit: options.limit ?? 10,
      sortValueType: 'string',
    });
    const baseWhere = {
      deletedAt: null as null,
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
      ...(options.search?.trim()
        ? {
            name: {
              contains: options.search.trim(),
              mode: 'insensitive' as const,
            },
          }
        : {}),
    };
    const employees = await this.tenantDb.db.employee.findMany({
      where: {
        ...baseWhere,
        ...(pagination.where ?? {}),
      },
      include: {
        tenant: { select: { code: true, name: true } },
        designation: { select: { name: true } },
        payrollGroup: { select: { name: true } },
        payrolls: {
          where: { deletedAt: null },
          select: { netPay: true, payrollMonth: true },
          orderBy: { payrollMonth: 'desc' },
          take: 1,
        },
        _count: { select: { payrolls: { where: { deletedAt: null } } } },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });

    const employeeTotal =
      options.includeSummary === false && employees.length > 0
        ? null
        : await this.tenantDb.db.employee.count({ where: baseWhere });

    if ((employeeTotal ?? employees.length) > 0) {
      const employeeIds = employees.map((row) => row.id);
      const netPayAgg =
        employeeIds.length > 0
          ? await this.tenantDb.db.payroll.groupBy({
              by: ['employeeRecordId'],
              where: {
                deletedAt: null,
                employeeRecordId: { in: employeeIds },
              },
              _sum: { netPay: true },
            })
          : [];
      const netByEmployee = new Map(
        netPayAgg
          .filter((row) => row.employeeRecordId != null)
          .map((row) => [
            row.employeeRecordId as string,
            toNumber(row._sum.netPay ?? 0),
          ]),
      );

      const items = employees.map((row) => {
        const lastPayroll = row.payrolls[0];
        return {
          id: row.id,
          tenantId: row.tenantId,
          tenantCode: row.tenant.code,
          tenantName: row.tenant.name,
          employeeName: row.name,
          employeeId: row.employeeCode,
          locationCode: row.locationCode,
          locationCodes:
            row.locationCodes?.length > 0
              ? row.locationCodes
              : row.locationCode
                ? [row.locationCode]
                : [],
          designationId: row.designationId,
          designationName: row.designation.name,
          payrollGroupId: row.payrollGroupId,
          payrollGroupName: row.payrollGroup?.name ?? null,
          payrollCount: row._count.payrolls,
          lastPayrollMonth: lastPayroll
            ? toIso(lastPayroll.payrollMonth)
            : toIso(row.createdAt),
          totalNetPay: netByEmployee.get(row.id) ?? 0,
        };
      });

      const pageLimit = options.limit ?? 10;
      if (options.includeSummary === false) {
        return { items, hasMore: items.length >= pageLimit };
      }
      return {
        items,
        totalCount: employeeTotal ?? items.length,
        hasMore: items.length >= pageLimit,
      };
    }

    // Fallback: derive roster from payroll history when Employee rows are absent
    const fallback = await this.queryWorkforceFromPayroll(options);
    const pageLimit = options.limit ?? 10;
    if (options.includeSummary === false) {
      return {
        items: fallback,
        hasMore: fallback.length >= pageLimit,
      };
    }
    return {
      items: fallback,
      totalCount: fallback.length,
      hasMore: false,
    };
  }

  private async queryWorkforceFromPayroll(options: {
    tenantId?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  }): Promise<WorkforceMember[]> {
    const limit = options.limit ?? 10;
    const rows = await this.tenantDb.db.payroll.findMany({
      where: {
        deletedAt: null,
        ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        ...(options.search?.trim()
          ? {
              employeeName: {
                contains: options.search.trim(),
                mode: 'insensitive' as const,
              },
            }
          : {}),
      },
      include: {
        tenant: { select: { code: true, name: true } },
        designation: { select: { name: true } },
        payrollGroup: { select: { name: true } },
      },
      orderBy: [
        { tenantId: 'asc' },
        { employeeName: 'asc' },
        { payrollMonth: 'desc' },
      ],
      take: Math.min(limit * 20, 2000),
    });

    const grouped = new Map<string, WorkforceMember>();

    for (const row of rows) {
      const memberId = row.employeeRecordId?.trim() || null;
      const key = memberId
        ? `id::${memberId}`
        : `${row.tenantId}::${row.employeeName}`;
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          id: memberId ?? key,
          tenantId: row.tenantId,
          tenantCode: row.tenant.code,
          tenantName: row.tenant.name,
          employeeName: row.employeeName,
          employeeId: row.employeeId,
          locationCode: row.locationCode,
          designationId: row.designationId,
          designationName: row.designation?.name ?? null,
          payrollGroupId: row.payrollGroupId,
          payrollGroupName: row.payrollGroup?.name ?? null,
          payrollCount: 1,
          lastPayrollMonth: toIso(row.payrollMonth),
          totalNetPay: toNumber(row.netPay),
        });
        continue;
      }

      existing.payrollCount += 1;
      existing.totalNetPay += toNumber(row.netPay);
      if (row.employeeId && !existing.employeeId) {
        existing.employeeId = row.employeeId;
      }
      if (row.locationCode && !existing.locationCode) {
        existing.locationCode = row.locationCode;
      }
      if (row.designationId && !existing.designationId) {
        existing.designationId = row.designationId;
        existing.designationName = row.designation?.name ?? null;
      }
      if (row.payrollMonth > new Date(existing.lastPayrollMonth)) {
        existing.lastPayrollMonth = toIso(row.payrollMonth);
      }
    }

    return [...grouped.values()]
      .sort((a, b) => {
        const tenantCompare = (a.tenantCode ?? '').localeCompare(
          b.tenantCode ?? '',
        );
        if (tenantCompare !== 0) return tenantCompare;
        return a.employeeName.localeCompare(b.employeeName);
      })
      .slice(0, limit);
  }

  async listDesignations(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    includeSummary?: boolean;
  } = {}): Promise<{
    items: Designation[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const pageLimit = filters.limit ?? 10;
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: pageLimit,
      sortValueType: 'string',
    });
    const baseWhere = {
      tenantId,
      deletedAt: null as null,
      ...(filters.search
        ? { name: { contains: filters.search, mode: 'insensitive' as const } }
        : {}),
    };
    const rows = await this.tenantDb.db.designation.findMany({
      where: {
        ...baseWhere,
        ...(pagination.where ?? {}),
      },
      include: { _count: { select: { employees: true } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    const items = rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description ?? null,
      employeeCount: row._count.employees,
      createdAt: toIso(row.createdAt),
    }));
    if (filters.includeSummary === false) {
      return { items, hasMore: items.length >= pageLimit };
    }
    const totalCount = await this.tenantDb.db.designation.count({
      where: baseWhere,
    });
    return { items, totalCount, hasMore: items.length >= pageLimit };
  }

  async createDesignation(dto: CreateDesignationRequest): Promise<Designation> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('Designation name is required');
    }
    const row = await this.tenantDb.db.designation.create({
      data: {
        tenantId,
        name,
        description: dto.description?.trim() || null,
      },
      include: { _count: { select: { employees: true } } },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description ?? null,
      employeeCount: row._count.employees,
      createdAt: toIso(row.createdAt),
    };
  }

  async updateDesignation(
    id: string,
    dto: { name?: string; description?: string | null },
  ): Promise<Designation> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.designation.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) {
      throw new BadRequestException('Designation not found');
    }
    const row = await this.tenantDb.db.designation.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description?.trim() || null }
          : {}),
      },
      include: { _count: { select: { employees: true } } },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      description: row.description ?? null,
      employeeCount: row._count.employees,
      createdAt: toIso(row.createdAt),
    };
  }

  async deleteDesignation(id: string): Promise<{ ok: true }> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.designation.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) {
      throw new BadRequestException('Designation not found');
    }
    await this.tenantDb.db.designation.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  async listEmployees(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    designationId?: string;
    locationCode?: string;
    serviceStaffOnly?: boolean;
  } = {}): Promise<Employee[]> {
    const tenantId = this.tenantDb.requireTenantId();
    // Repair before list cache so an empty cached picker cannot block sync
    // (VS: role isServiceStaff true, Employee flags still false).
    if (filters.serviceStaffOnly) {
      await this.ensureServiceStaffFlagsSynced(tenantId);
    }
    const filterKey = listPageFilterKey({
      search: filters.search,
      designationId: filters.designationId,
      locationCode: filters.locationCode,
      serviceStaffOnly: filters.serviceStaffOnly ? 1 : 0,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'hrm-employees',
      filterKey,
      () => this.listEmployeesUncached(filters, tenantId),
    );
  }

  /** When no employees are flagged, force a full user→employee sync. */
  private async ensureServiceStaffFlagsSynced(tenantId: string): Promise<void> {
    const flaggedCount = await this.tenantDb.db.employee.count({
      where: { tenantId, deletedAt: null, isServiceStaff: true },
    });
    if (flaggedCount === 0) {
      await this.cache.del(`hrm:service-staff-user-sync:${tenantId}`);
      await this.syncServiceStaffFromUsers(tenantId).catch(() => undefined);
      return;
    }
    await this.syncServiceStaffFromUsersThrottled(tenantId);
  }

  private async listEmployeesUncached(
    filters: {
      cursor?: string;
      limit?: number;
      search?: string;
      designationId?: string;
      locationCode?: string;
      serviceStaffOnly?: boolean;
    },
    tenantId: string,
  ): Promise<Employee[]> {
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'string',
    });
    const rows = await this.tenantDb.db.employee.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.serviceStaffOnly ? { isServiceStaff: true } : {}),
        ...(filters.designationId
          ? { designationId: filters.designationId }
          : {}),
        ...(filters.locationCode
          ? {
              OR: [
                { locationCode: filters.locationCode },
                { locationCodes: { has: filters.locationCode } },
              ],
            }
          : {}),
        ...(filters.search
          ? {
              OR: [
                { name: { contains: filters.search, mode: 'insensitive' } },
                {
                  employeeCode: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
        ...(pagination.where ?? {}),
      },
      include: {
        designation: { select: { name: true } },
        payrollGroup: { select: { name: true } },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    return rows.map((row) => this.serializeEmployee(row));
  }

  /**
   * Add Payroll roster: Users for this tenant ∪ Users with a peer Employee
   * here (multi-entity). Names always come from User; orphans without userId
   * are excluded. Ensures a local Employee row exists for each candidate.
   */
  async listPayrollCandidates(): Promise<PayrollCandidate[]> {
    const tenantId = this.tenantDb.requireTenantId();

    const [homeUsers, peerEmployees] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          tenantId,
          deletedAt: null,
          status: { in: ['active', 'invited', 'suspended'] },
        },
        select: {
          id: true,
          name: true,
          tenantRole: {
            select: { name: true, isServiceStaff: true },
          },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.employee.findMany({
        where: {
          tenantId,
          deletedAt: null,
          userId: { not: null },
        },
        select: {
          id: true,
          userId: true,
          name: true,
          employeeCode: true,
          locationCode: true,
          locationCodes: true,
          payrollGroupId: true,
          designationId: true,
          department: true,
          isServiceStaff: true,
          designation: { select: { name: true } },
          payrollGroup: { select: { name: true } },
          user: {
            select: {
              id: true,
              name: true,
              deletedAt: true,
              status: true,
              tenantRole: {
                select: { name: true, isServiceStaff: true },
              },
            },
          },
        },
      }),
    ]);

    const userIds = new Set<string>(homeUsers.map((u) => u.id));
    for (const emp of peerEmployees) {
      if (
        emp.userId &&
        emp.user &&
        !emp.user.deletedAt &&
        (emp.user.status === 'active' ||
          emp.user.status === 'invited' ||
          emp.user.status === 'suspended')
      ) {
        userIds.add(emp.userId);
      }
    }

    if (userIds.size === 0) return [];

    const employeeByUserId = new Map(
      peerEmployees
        .filter((e): e is typeof e & { userId: string } => Boolean(e.userId))
        .map((e) => [e.userId, e]),
    );

    const usersById = new Map(homeUsers.map((u) => [u.id, u]));
    for (const emp of peerEmployees) {
      if (emp.user && !usersById.has(emp.user.id)) {
        usersById.set(emp.user.id, {
          id: emp.user.id,
          name: emp.user.name,
          tenantRole: emp.user.tenantRole,
        });
      }
    }

    let defaultDesignationId =
      (
        await this.prisma.designation.findFirst({
          where: {
            tenantId,
            deletedAt: null,
            name: { equals: 'Staff', mode: 'insensitive' },
          },
          select: { id: true },
        })
      )?.id ?? null;
    if (!defaultDesignationId) {
      const created = await this.prisma.designation.create({
        data: { tenantId, name: 'Staff' },
        select: { id: true },
      });
      defaultDesignationId = created.id;
    }

    const candidates: PayrollCandidate[] = [];

    for (const userId of userIds) {
      const user = usersById.get(userId);
      if (!user) continue;
      const userName = user.name.trim() || 'Staff';
      let emp = employeeByUserId.get(userId);

      if (!emp) {
        const roleName = user.tenantRole?.name?.trim();
        let designationId = defaultDesignationId;
        if (roleName) {
          const found = await this.prisma.designation.findFirst({
            where: {
              tenantId,
              deletedAt: null,
              name: { equals: roleName, mode: 'insensitive' },
            },
            select: { id: true },
          });
          if (found) designationId = found.id;
        }
        const isServiceStaff = isServiceStaffEligible({
          roleIsServiceStaff: user.tenantRole?.isServiceStaff,
          designation: roleName,
        });
        const created = await this.prisma.employee.create({
          data: {
            tenantId,
            name: userName,
            userId,
            designationId,
            isServiceStaff,
            locationCodes: [],
          },
          include: {
            designation: { select: { name: true } },
            payrollGroup: { select: { name: true } },
          },
        });
        emp = {
          id: created.id,
          userId,
          name: created.name,
          employeeCode: created.employeeCode,
          locationCode: created.locationCode,
          locationCodes: created.locationCodes,
          payrollGroupId: created.payrollGroupId,
          designationId: created.designationId,
          department: created.department,
          isServiceStaff: created.isServiceStaff,
          designation: created.designation,
          payrollGroup: created.payrollGroup,
          user: {
            id: user.id,
            name: user.name,
            deletedAt: null,
            status: 'active',
            tenantRole: user.tenantRole,
          },
        };
        employeeByUserId.set(userId, emp);
      } else if (emp.name.trim() !== userName) {
        await this.prisma.employee.update({
          where: { id: emp.id },
          data: { name: userName },
        });
        emp = { ...emp, name: userName };
      }

      const designationName = emp.designation?.name ?? 'Staff';
      const roleName = user.tenantRole?.name ?? null;
      const staffBucket = resolvePayrollStaffBucket({
        roleName,
        designation: designationName,
        department: emp.department,
        isServiceStaff: emp.isServiceStaff,
        roleIsServiceStaff: user.tenantRole?.isServiceStaff,
      });

      const locationCodes =
        emp.locationCodes?.length > 0
          ? emp.locationCodes
          : emp.locationCode
            ? [emp.locationCode]
            : [];

      candidates.push({
        id: emp.id,
        tenantId,
        userId,
        name: userName,
        employeeCode: emp.employeeCode,
        locationCode: locationCodes[0] ?? emp.locationCode,
        locationCodes,
        payrollGroupId: emp.payrollGroupId,
        payrollGroupName: emp.payrollGroup?.name ?? null,
        designationId: emp.designationId,
        designationName,
        department: emp.department,
        isServiceStaff: emp.isServiceStaff,
        staffBucket,
        tenantRoleName: roleName,
      });
    }

    candidates.sort((a, b) => a.name.localeCompare(b.name));
    return candidates;
  }

  /**
   * Employee linked to a login user (user edit hydrate).
   * Prefers the request-scoped tenant row, but always returns the union of
   * work-location clearances across every entity copy for that user.
   */
  async getEmployeeByUserId(userId: string): Promise<Employee | null> {
    const scopedTenantId = this.tenantDb.resolveTenantId();
    const rows = await this.prisma.employee.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: {
        designation: { select: { name: true } },
        payrollGroup: { select: { name: true } },
      },
    });
    if (rows.length === 0) return null;

    const preferred =
      (scopedTenantId
        ? rows.find((row) => row.tenantId === scopedTenantId)
        : undefined) ?? rows[0]!;

    const locationCodes = [
      ...new Set(
        rows.flatMap((row) => {
          const codes =
            row.locationCodes?.length > 0
              ? row.locationCodes
              : row.locationCode
                ? [row.locationCode]
                : [];
          return codes.map((c) => c.trim()).filter(Boolean);
        }),
      ),
    ];

    return this.serializeEmployee({
      ...preferred,
      locationCode: locationCodes[0] ?? preferred.locationCode,
      locationCodes,
    });
  }

  async createEmployee(dto: CreateEmployeeRequest): Promise<Employee> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('Employee name is required');
    }
    if (!dto.designationId?.trim()) {
      throw new BadRequestException('Designation is required');
    }
    const designation = await this.tenantDb.db.designation.findFirst({
      where: {
        id: dto.designationId,
        tenantId,
        deletedAt: null,
      },
    });
    if (!designation) {
      throw new BadRequestException('Designation not found');
    }

    const isServiceStaff =
      dto.isServiceStaff ??
      isServiceStaffEligible({
        designation: designation.name,
        department: dto.department,
      });

    const locationCodes = normalizeLocationCodes(
      dto.locationCodes,
      dto.locationCode,
    );

    const row = await this.tenantDb.db.employee.create({
      data: {
        tenantId,
        name,
        employeeCode: dto.employeeCode?.trim() || null,
        locationCode: locationCodes[0] ?? null,
        locationCodes,
        payrollGroupId: dto.payrollGroupId?.trim() || null,
        designationId: dto.designationId,
        userId: dto.userId?.trim() || null,
        isServiceStaff,
        accountHolderName: dto.accountHolderName?.trim() || null,
        bankName: dto.bankName?.trim() || null,
        bankBranch: dto.bankBranch?.trim() || null,
        bankCode: dto.bankCode?.trim() || null,
        bankAccountNo: dto.bankAccountNo?.trim() || null,
        taxPayerId: dto.taxPayerId?.trim() || null,
        ...employeeProfileCreateData(dto),
      },
      include: {
        designation: { select: { name: true } },
        payrollGroup: { select: { name: true } },
      },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    const created = this.serializeEmployee(row);
    if (dto.userId?.trim() && locationCodes.length > 0) {
      await this.mirrorWorkLocationsToPeerEmployees(
        dto.userId.trim(),
        row.id,
        locationCodes,
      );
    }
    return created;
  }

  /**
   * Sync work-location clearance for a login user (header location switcher).
   * Creates a minimal employee row if none exists yet.
   * Also updates designation + bank/tax fields when provided (user edit form).
   */
  async syncEmployeeLocationsByUserId(
    args: SyncEmployeeByUserRequest & { userId: string },
  ): Promise<Employee | null> {
    const tenantId = this.tenantDb.requireTenantId();
    const locationCodes = normalizeLocationCodes(
      args.locationCodes,
      args.locationCode,
    );

    const existing = await this.tenantDb.db.employee.findFirst({
      where: { userId: args.userId, tenantId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    });

    if (args.designationId?.trim()) {
      const designation = await this.tenantDb.db.designation.findFirst({
        where: {
          id: args.designationId.trim(),
          tenantId,
          deletedAt: null,
        },
      });
      if (!designation) {
        throw new BadRequestException('Designation not found');
      }
    }

    const profilePatch = employeeProfilePatchData(args);

    const serviceStaffFlag = await this.resolveServiceStaffForUserSync({
      userId: args.userId,
      designationId:
        args.designationId?.trim() || existing?.designationId || undefined,
      department:
        args.department !== undefined
          ? args.department
          : (existing?.department ?? null),
      explicit: args.isServiceStaff,
    });

    if (existing) {
      const nextLocations =
        locationCodes.length > 0
          ? locationCodes
          : existing.locationCodes?.length
            ? existing.locationCodes
            : existing.locationCode
              ? [existing.locationCode]
              : [];
      const row = await this.tenantDb.db.employee.update({
        where: { id: existing.id },
        data: {
          ...(nextLocations.length > 0
            ? {
                locationCodes: nextLocations,
                locationCode: nextLocations[0] ?? null,
              }
            : {}),
          ...(args.name?.trim() ? { name: args.name.trim() } : {}),
          ...(args.designationId?.trim()
            ? { designationId: args.designationId.trim() }
            : {}),
          isServiceStaff: serviceStaffFlag,
          ...profilePatch,
        },
        include: {
          designation: { select: { name: true } },
          payrollGroup: { select: { name: true } },
        },
      });
      if (nextLocations.length > 0) {
        await this.mirrorWorkLocationsToPeerEmployees(
          args.userId,
          row.id,
          nextLocations,
        );
      }
      return this.serializeEmployee(row);
    }

    if (locationCodes.length === 0) return null;

    const designationId =
      args.designationId?.trim() ||
      (
        await this.tenantDb.db.designation.findFirst({
          where: { tenantId, deletedAt: null },
          orderBy: { name: 'asc' },
        })
      )?.id;
    if (!designationId) {
      throw new BadRequestException(
        'Create a designation before assigning work locations',
      );
    }

    const created = await this.createEmployee({
      name: args.name?.trim() || 'Staff',
      userId: args.userId,
      designationId,
      locationCodes,
      locationCode: locationCodes[0],
      isServiceStaff: serviceStaffFlag,
      accountHolderName: args.accountHolderName,
      bankName: args.bankName,
      bankBranch: args.bankBranch,
      bankCode: args.bankCode,
      bankAccountNo: args.bankAccountNo,
      taxPayerId: args.taxPayerId,
      mobile: args.mobile,
      altContact: args.altContact,
      familyContact: args.familyContact,
      guardianName: args.guardianName,
      dateOfBirth: args.dateOfBirth,
      gender: args.gender,
      maritalStatus: args.maritalStatus,
      bloodGroup: args.bloodGroup,
      idProofName: args.idProofName,
      idProofNumber: args.idProofNumber,
      permanentAddress: args.permanentAddress,
      currentAddress: args.currentAddress,
      salesCommission: args.salesCommission,
      maxSalesDiscountPercent: args.maxSalesDiscountPercent,
      department: args.department,
    });
    await this.mirrorWorkLocationsToPeerEmployees(
      args.userId,
      created.id,
      locationCodes,
    );
    return created;
  }

  /**
   * Role toggle OR designation OR department → Employee.isServiceStaff.
   * Used when syncing a login user into the HRM roster (sales service-staff picker).
   */
  private async resolveServiceStaffForUserSync(args: {
    userId: string;
    designationId?: string;
    department?: string | null;
    explicit?: boolean;
  }): Promise<boolean> {
    if (args.explicit !== undefined) return Boolean(args.explicit);

    const user = await this.tenantDb.db.user.findFirst({
      where: { id: args.userId, deletedAt: null },
      select: {
        tenantRole: { select: { isServiceStaff: true } },
      },
    });

    let designationName: string | null = null;
    if (args.designationId) {
      const designation = await this.tenantDb.db.designation.findFirst({
        where: { id: args.designationId, deletedAt: null },
        select: { name: true },
      });
      designationName = designation?.name ?? null;
    }

    return isServiceStaffEligible({
      roleIsServiceStaff: user?.tenantRole?.isServiceStaff,
      designation: designationName,
      department: args.department,
    });
  }

  /**
   * Align Employee.isServiceStaff with active Users (role + department + designation).
   * Creates a minimal employee row when an eligible user has no payroll link yet.
   */
  private async syncServiceStaffFromUsersThrottled(
    tenantId: string,
  ): Promise<void> {
    const cacheKey = `hrm:service-staff-user-sync:${tenantId}`;
    const cached = await this.cache.get<string>(cacheKey);
    if (cached) return;
    await this.cache.set(cacheKey, '1', 60);
    try {
      await this.syncServiceStaffFromUsers(tenantId);
    } catch {
      await this.cache.del(cacheKey);
      // List still returns current flags; next picker open retries sync.
    }
  }

  async syncServiceStaffFromUsers(tenantId: string): Promise<{
    updated: number;
    created: number;
  }> {
    // Include invited/suspended — login status must not hide staff who still
    // appear on sales / the roster (VS stylists were all suspended).
    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: { in: ['active', 'invited', 'suspended'] },
      },
      select: {
        id: true,
        name: true,
        status: true,
        tenantRole: {
          select: { name: true, isServiceStaff: true },
        },
      },
      orderBy: { name: 'asc' },
    });
    if (users.length === 0) return { updated: 0, created: 0 };

    const employees = await this.prisma.employee.findMany({
      where: {
        tenantId,
        deletedAt: null,
        userId: { in: users.map((u) => u.id) },
      },
      select: {
        id: true,
        userId: true,
        isServiceStaff: true,
        department: true,
        designationId: true,
        designation: { select: { name: true } },
      },
    });
    const employeeByUserId = new Map(
      employees
        .filter((e): e is typeof e & { userId: string } => Boolean(e.userId))
        .map((e) => [e.userId, e]),
    );

    let defaultDesignationId =
      (
        await this.prisma.designation.findFirst({
          where: { tenantId, deletedAt: null },
          orderBy: { name: 'asc' },
          select: { id: true },
        })
      )?.id ?? null;

    if (!defaultDesignationId) {
      const createdDesignation = await this.prisma.designation.create({
        data: { tenantId, name: 'Staff' },
        select: { id: true },
      });
      defaultDesignationId = createdDesignation.id;
    }

    const designationIdByRoleName = new Map<string, string>();
    let updated = 0;
    let created = 0;

    for (const user of users) {
      const existing = employeeByUserId.get(user.id);
      const should = isServiceStaffEligible({
        roleIsServiceStaff: user.tenantRole?.isServiceStaff,
        designation:
          existing?.designation?.name ?? user.tenantRole?.name ?? null,
        department: existing?.department,
      });

      if (existing) {
        if (existing.isServiceStaff !== should) {
          await this.prisma.employee.update({
            where: { id: existing.id },
            data: { isServiceStaff: should },
          });
          updated += 1;
        }
        continue;
      }

      // Only auto-create roster rows for people who can still log in.
      if (!should || user.status === 'suspended') continue;

      const roleName = user.tenantRole?.name?.trim();
      let designationId = defaultDesignationId;
      if (roleName) {
        const cachedId = designationIdByRoleName.get(roleName.toLowerCase());
        if (cachedId) {
          designationId = cachedId;
        } else {
          const found = await this.prisma.designation.findFirst({
            where: {
              tenantId,
              deletedAt: null,
              name: { equals: roleName, mode: 'insensitive' },
            },
            select: { id: true },
          });
          if (found) {
            designationId = found.id;
            designationIdByRoleName.set(roleName.toLowerCase(), found.id);
          }
        }
      }

      await this.prisma.employee.create({
        data: {
          tenantId,
          name: user.name.trim() || 'Staff',
          userId: user.id,
          designationId,
          isServiceStaff: true,
          locationCodes: [],
        },
      });
      created += 1;
    }

    // Also flag unlinked / leftover employees via department / designation.
    const orphanEmployees = await this.prisma.employee.findMany({
      where: {
        tenantId,
        deletedAt: null,
        isServiceStaff: false,
        OR: [
          { userId: null },
          { userId: { notIn: users.map((u) => u.id) } },
        ],
      },
      select: {
        id: true,
        department: true,
        designation: { select: { name: true } },
      },
    });
    for (const emp of orphanEmployees) {
      const should = isServiceStaffEligible({
        designation: emp.designation?.name,
        department: emp.department,
      });
      if (!should) continue;
      await this.prisma.employee.update({
        where: { id: emp.id },
        data: { isServiceStaff: true },
      });
      updated += 1;
    }

    if (updated > 0 || created > 0) {
      void invalidateTenantDashboardCache(this.cache, tenantId);
      void this.cache.bumpListVersion(tenantId, 'hrm-employees');
    }
    return { updated, created };
  }

  /**
   * Keep every entity's employee copy of this login user on the same
   * work-location clearance set (header switcher + multi-entity lists).
   */
  private async mirrorWorkLocationsToPeerEmployees(
    userId: string,
    sourceEmployeeId: string,
    locationCodes: string[],
  ): Promise<void> {
    if (locationCodes.length === 0) return;
    await this.prisma.employee.updateMany({
      where: {
        userId,
        deletedAt: null,
        NOT: { id: sourceEmployeeId },
      },
      data: {
        locationCodes,
        locationCode: locationCodes[0] ?? null,
      },
    });
  }

  async listPayrolls(filters: PayrollFilters & { includeSummary?: boolean } = {}): Promise<{
    items: Payroll[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      year: filters.year,
      month: filters.month,
      payrollGroupId: filters.payrollGroupId,
      employeeRecordId: filters.employeeRecordId,
      locationCode: filters.locationCode,
      designationId: filters.designationId,
      status: filters.status,
      paymentStatus: filters.paymentStatus,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
      sum: filters.includeSummary === false ? 0 : 1,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'hrm-payrolls',
      filterKey,
      () => this.listPayrollsUncached(filters, tenantId),
    );
  }

  /** VAG super-admin: payrolls across all operating tenants. */
  async listPayrollsAllTenants(
    requestRole: string,
    filters: PayrollFilters & { includeSummary?: boolean } = {},
  ): Promise<{
    items: Payroll[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    if (requestRole !== 'super_admin') {
      throw new ForbiddenException('Super admin access required');
    }
    const filterKey = listPageFilterKey({
      search: filters.search,
      year: filters.year,
      month: filters.month,
      payrollGroupId: filters.payrollGroupId,
      employeeRecordId: filters.employeeRecordId,
      locationCode: filters.locationCode,
      designationId: filters.designationId,
      department: filters.department,
      tenantCode: filters.tenantCode,
      status: filters.status,
      paymentStatus: filters.paymentStatus,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
      sum: filters.includeSummary === false ? 0 : 1,
    });
    return withListPageCache(
      this.cache,
      '__all__',
      'hrm-payrolls-all',
      filterKey,
      () => this.listPayrollsUncached(filters, null),
    );
  }

  private async listPayrollsUncached(
    filters: PayrollFilters & { includeSummary?: boolean },
    tenantId: string | null,
  ): Promise<{
    items: Payroll[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const monthYearFilter =
      filters.year != null || filters.month != null
        ? (() => {
            const year = filters.year ?? new Date().getFullYear();
            const monthIndex = (filters.month ?? 1) - 1;
            const start = new Date(Date.UTC(year, monthIndex, 1));
            const end =
              filters.month != null
                ? new Date(Date.UTC(year, monthIndex + 1, 1))
                : new Date(Date.UTC(year + 1, 0, 1));
            return { payrollMonth: { gte: start, lt: end } };
          })()
        : {};

    const sort = resolveListSort(filters.sortBy, filters.sortDir, {
      payrollMonth: { field: 'payrollMonth', type: 'date' },
      employeeName: { field: 'employeeName', type: 'string' },
      grossPay: { field: 'grossPay', type: 'number' },
      totalAllowance: { field: 'totalAllowance', type: 'number' },
      totalDeduction: { field: 'totalDeduction', type: 'number' },
      netPay: { field: 'netPay', type: 'number' },
      status: { field: 'status', type: 'string' },
      paymentStatus: { field: 'paymentStatus', type: 'string' },
    }, {
      sortField: 'payrollMonth',
      sortDir: 'desc',
      sortValueType: 'date',
    });

    const pagination = buildCompositeCursorQuery({
      sortField: sort.sortField,
      sortDir: sort.sortDir,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: sort.sortValueType,
    });

    const tenantCode = filters.tenantCode?.trim();
    const baseWhere = {
      ...(tenantId ? { tenantId } : {}),
      deletedAt: null as null,
      ...monthYearFilter,
      ...(filters.payrollGroupId
        ? { payrollGroupId: filters.payrollGroupId }
        : {}),
      ...(filters.employeeRecordId
        ? { employeeRecordId: filters.employeeRecordId }
        : {}),
      ...(filters.locationCode
        ? { locationCode: filters.locationCode }
        : {}),
      ...(filters.designationId
        ? { designationId: filters.designationId }
        : {}),
      ...(filters.department
        ? {
            employeeRecord: {
              department: {
                equals: filters.department.trim(),
                mode: 'insensitive' as const,
              },
            },
          }
        : {}),
      ...(tenantCode
        ? { tenant: { code: tenantCode } }
        : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.paymentStatus
        ? { paymentStatus: filters.paymentStatus }
        : {}),
      ...(filters.search
        ? {
            OR: [
              {
                employeeName: {
                  contains: filters.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                employeeId: {
                  contains: filters.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                locationCode: {
                  contains: filters.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                note: {
                  contains: filters.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                payrollGroup: {
                  name: {
                    contains: filters.search,
                    mode: 'insensitive' as const,
                  },
                },
              },
              ...(tenantId
                ? []
                : [
                    {
                      tenant: {
                        code: {
                          contains: filters.search,
                          mode: 'insensitive' as const,
                        },
                      },
                    },
                    {
                      tenant: {
                        name: {
                          contains: filters.search,
                          mode: 'insensitive' as const,
                        },
                      },
                    },
                  ]),
            ],
          }
        : {}),
    };

    const rows = await this.tenantDb.db.payroll.findMany({
      where: {
        ...baseWhere,
        ...(pagination.where ?? {}),
      },
      include: {
        ...PAYROLL_INCLUDE,
        ...(tenantId
          ? {}
          : { tenant: { select: { code: true, name: true } } }),
      },
      orderBy: [{ [sort.sortField]: sort.sortDir }, { id: sort.sortDir }],
      take: pagination.take,
    });
    const items = rows.map((row) => this.serializePayroll(row));
    const pageLimit = filters.limit ?? 10;
    if (filters.includeSummary === false) {
      return { items, hasMore: items.length >= pageLimit };
    }
    const totalCount = await this.tenantDb.db.payroll.count({
      where: baseWhere,
    });
    return {
      items,
      totalCount,
      hasMore: items.length >= pageLimit,
    };
  }

  async createPayroll(dto: CreatePayrollRequest): Promise<Payroll> {
    const tenantId = this.tenantDb.requireTenantId();
    const allowance = dto.totalAllowance ?? 0;
    const deduction = dto.totalDeduction ?? 0;
    const netPay = dto.grossPay + allowance - deduction;

    let employeeName = dto.employeeName?.trim() || '';
    let employeeId = dto.employeeId ?? null;
    let employeeRecordId = dto.employeeRecordId ?? null;
    let designationId = dto.designationId ?? null;
    let payrollGroupId = dto.payrollGroupId ?? null;
    let locationCode = dto.locationCode ?? null;
    let designationNameHint: string | null = null;

    if (dto.employeeRecordId) {
      const recordKey = dto.employeeRecordId.trim();
      // Workforce fallback used synthetic ids like `${tenantId}::${name}`.
      const isSyntheticId = recordKey.includes('::');
      const employee = isSyntheticId
        ? await this.tenantDb.db.employee.findFirst({
            where: {
              tenantId,
              deletedAt: null,
              name: {
                equals: recordKey.split('::').slice(1).join('::').trim(),
                mode: 'insensitive',
              },
            },
            include: {
              designation: { select: { id: true, name: true, deletedAt: true } },
            },
          })
        : await this.tenantDb.db.employee.findFirst({
            where: {
              id: recordKey,
              tenantId,
              deletedAt: null,
            },
            include: {
              designation: { select: { id: true, name: true, deletedAt: true } },
            },
          });
      if (!employee) {
        throw new BadRequestException(
          isSyntheticId
            ? 'Employee record not found — open Users and create an HR employee for this person first'
            : 'Employee not found',
        );
      }
      employeeRecordId = employee.id;
      employeeName = employee.name;
      employeeId = employee.employeeCode;
      designationId = employee.designationId;
      designationNameHint = employee.designation?.name ?? null;
      payrollGroupId = employee.payrollGroupId ?? payrollGroupId;
      locationCode = employee.locationCode ?? locationCode;
    }

    if (!employeeName) {
      throw new BadRequestException(
        'employeeRecordId or employeeName is required',
      );
    }

    designationId = await this.resolveActiveDesignationId(
      tenantId,
      designationId,
      designationNameHint,
    );

    const status =
      dto.status === 'final' || dto.status === 'paid' || dto.status === 'draft'
        ? dto.status
        : 'draft';

    const row = await this.tenantDb.db.payroll.create({
      data: {
        tenantId,
        employeeRecordId,
        employeeName,
        employeeId,
        designationId,
        payrollGroupId,
        locationCode,
        grossPay: dto.grossPay,
        totalAllowance: allowance,
        totalDeduction: deduction,
        netPay,
        status,
        payrollMonth: new Date(dto.payrollMonth),
        note: dto.note ?? null,
      },
      include: {
        payrollGroup: true,
        designation: { select: { name: true } },
        employeeRecord: {
          select: {
            accountHolderName: true,
            bankName: true,
            bankBranch: true,
            bankCode: true,
            bankAccountNo: true,
            taxPayerId: true,
          },
        },
      },
    });
    await this.invoiceHub.ensurePayrollInvoice(this.tenantDb.db, row);
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return this.serializePayroll(row);
  }

  /**
   * Payroll requires an active designation. Migrated employees sometimes point
   * at soft-deleted designations — repair to an active row (or create Staff).
   */
  private async resolveActiveDesignationId(
    tenantId: string,
    designationId: string | null | undefined,
    nameHint?: string | null,
  ): Promise<string> {
    if (designationId) {
      const active = await this.tenantDb.db.designation.findFirst({
        where: { id: designationId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (active) return active.id;

      // findUnique bypasses soft-delete filter — recover the deleted name.
      const anyRow = await this.tenantDb.db.designation.findUnique({
        where: { id: designationId },
        select: { name: true, tenantId: true },
      });
      if (anyRow?.tenantId === tenantId && anyRow.name?.trim()) {
        nameHint = anyRow.name;
      } else {
        const softDeleted = await this.tenantDb.db.designation.findFirst({
          where: {
            id: designationId,
            tenantId,
            deletedAt: { not: null },
          },
          select: { name: true },
        });
        if (softDeleted?.name?.trim()) {
          nameHint = softDeleted.name;
        }
      }
    }

    const hint = nameHint?.trim() || 'Staff';
    const byName = await this.tenantDb.db.designation.findFirst({
      where: {
        tenantId,
        deletedAt: null,
        name: { equals: hint, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (byName) {
      if (designationId && designationId !== byName.id) {
        // Heal employee rows still pointing at a deleted designation.
        await this.tenantDb.db.employee.updateMany({
          where: { tenantId, designationId, deletedAt: null },
          data: { designationId: byName.id },
        });
      }
      return byName.id;
    }

    const created = await this.tenantDb.db.designation.create({
      data: { tenantId, name: hint },
      select: { id: true },
    });
    if (designationId) {
      await this.tenantDb.db.employee.updateMany({
        where: { tenantId, designationId, deletedAt: null },
        data: { designationId: created.id },
      });
    }
    return created.id;
  }

  async payPayrolls(dto: PayPayrollsRequest): Promise<PayPayrollsResult> {
    const tenantId = this.tenantDb.requireTenantId();
    const payrollIds = [
      ...new Set(
        (dto.payrollIds ?? [])
          .map((id) => id?.trim())
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (payrollIds.length === 0) {
      throw new BadRequestException('Select at least one payroll to pay');
    }
    const accountId = dto.accountId?.trim();
    if (!accountId) {
      throw new BadRequestException('Payment account is required');
    }

    const account = await this.tenantDb.db.paymentAccount.findFirst({
      where: { id: accountId, tenantId, deletedAt: null },
      select: { id: true, name: true, isClosed: true },
    });
    if (!account) {
      throw new BadRequestException('Payment account not found');
    }
    if (account.isClosed) {
      throw new BadRequestException('Payment account is closed');
    }

    const paidOn = dto.paidOn ? new Date(dto.paidOn) : new Date();
    if (Number.isNaN(paidOn.getTime())) {
      throw new BadRequestException('Invalid paidOn date');
    }
    const method = dto.method?.trim() || 'cash';
    const note = dto.note?.trim() || null;
    const authorizedBy = await this.auditService.createdByFields();
    const authorizedByName = authorizedBy.createdByName?.trim() || null;

    const result = await this.tenantDb.db.$transaction(
      async (tx) => {
        const rows = await tx.payroll.findMany({
          where: { id: { in: payrollIds }, tenantId, deletedAt: null },
          include: {
            payrollGroup: true,
            designation: { select: { name: true } },
            employeeRecord: {
              select: {
                accountHolderName: true,
                bankName: true,
                bankBranch: true,
                bankCode: true,
                bankAccountNo: true,
                taxPayerId: true,
              },
            },
            invoice: {
              select: { id: true, reference: true, paymentStatus: true },
            },
          },
        });
        if (rows.length === 0) {
          throw new BadRequestException('No matching payrolls found');
        }

        let paid = 0;
        let skipped = 0;
        let totalDebited = 0;
        const updated: typeof rows = [];

        for (const row of rows) {
          if (row.paymentStatus === 'paid') {
            skipped += 1;
            updated.push(row);
            continue;
          }

          const netPay = toNumber(row.netPay);
          if (netPay <= 0) {
            skipped += 1;
            updated.push(row);
            continue;
          }

          let invoice = row.invoice;
          if (!invoice) {
            invoice = await this.invoiceHub.ensurePayrollInvoice(tx, row);
          }

          const paymentRefNo =
            await this.invoiceHub.nextPayrollPaymentReference(
              tx,
              tenantId,
              paidOn.getUTCFullYear(),
            );

          const payment = await tx.payment.create({
            data: {
              tenantId,
              amount: netPay,
              currency: 'NGN',
              method,
              paidOn,
              paymentFor: 'payroll',
              accountId: account.id,
              invoiceId: invoice.id,
              paymentRefNo,
              createdByName: authorizedByName,
              note:
                note ||
                `Payroll — ${row.employeeName} (${toIso(row.payrollMonth).slice(0, 7)})`,
            },
          });

          await recordPaymentAccountTxn(tx, {
            tenantId,
            accountId: account.id,
            type: 'debit',
            subType: 'payroll',
            amount: netPay,
            operationDate: paidOn,
            refNo: invoice.reference,
            note: payment.note,
            paymentMethod: method,
            paymentId: payment.id,
            invoiceId: invoice.id,
          });

          // Accrue wage expense once on pay (till already debited above).
          const monthLabel = toIso(row.payrollMonth).slice(0, 7);
          const payrollDescription = `Payroll — ${row.employeeName} (${monthLabel})`;

          let payrollCategory = await tx.expenseCategory.findFirst({
            where: {
              tenantId,
              deletedAt: null,
              name: { equals: 'Payroll', mode: 'insensitive' },
            },
            select: { id: true },
          });
          if (!payrollCategory) {
            payrollCategory = await tx.expenseCategory.create({
              data: { tenantId, name: 'Payroll', code: 'PAYROLL' },
              select: { id: true },
            });
          }

          // Expense row so Finance / Expenses results list payroll with other costs.
          // Ledger stays linked to payroll (single P&L hit — no second ledger line).
          await tx.expense.create({
            data: {
              tenantId,
              refNo: paymentRefNo,
              categoryId: payrollCategory.id,
              subCategory: 'Wages',
              totalAmount: netPay,
              paymentStatus: 'paid',
              paymentDue: 0,
              accountId: account.id,
              note: `${payrollDescription} · payrollId:${row.id}`,
              expenseDate: paidOn,
              createdByName: authorizedByName ?? 'HR / Payroll',
            },
          });

          await tx.ledgerEntry.create({
            data: {
              tenantId,
              type: 'expense',
              amount: netPay,
              currency: 'NGN',
              category: 'Payroll',
              description: payrollDescription,
              linkedRecordType: 'payroll',
              linkedRecordId: row.id,
              invoiceId: invoice.id,
              date: paidOn,
            },
          });

          await tx.invoice.update({
            where: { id: invoice.id },
            data: { paymentStatus: 'paid' },
          });

          const next = await tx.payroll.update({
            where: { id: row.id },
            data: {
              paymentStatus: 'paid',
              status: 'paid',
            },
            include: {
              payrollGroup: true,
              designation: { select: { name: true } },
              employeeRecord: {
                select: {
                  accountHolderName: true,
                  bankName: true,
                  bankBranch: true,
                  bankCode: true,
                  bankAccountNo: true,
                  taxPayerId: true,
                },
              },
              invoice: {
                select: { id: true, reference: true, paymentStatus: true },
              },
            },
          });

          paid += 1;
          totalDebited += netPay;
          updated.push(next);
        }

        return { paid, skipped, totalDebited, updated };
      },
      { maxWait: 15_000, timeout: 60_000 },
    );

    if (result.totalDebited > 0) {
      void applyDailyFinanceDelta(
        this.tenantDb.db,
        tenantId,
        paidOn,
        'expense',
        result.totalDebited,
      );
    }

    void invalidateTenantDashboardCache(this.cache, tenantId);

    return {
      paid: result.paid,
      skipped: result.skipped,
      totalDebited: result.totalDebited,
      accountId: account.id,
      accountName: account.name,
      payrolls: result.updated.map((row) => this.serializePayroll(row)),
    };
  }

  /**
   * Soft-delete a payroll row. Paid runs also reverse the linked payment,
   * payment-account debit, wage expense, ledger line, and invoice so Finance
   * and till balances stay consistent.
   */
  async deletePayroll(id: string): Promise<{ ok: true }> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.payroll.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        invoice: { select: { id: true, reference: true } },
      },
    });
    if (!existing) {
      throw new BadRequestException('Payroll not found');
    }
    if (existing.status === 'final') {
      throw new BadRequestException(
        'Cannot delete a payroll that is marked final',
      );
    }

    const wasPaid =
      existing.paymentStatus === 'paid' || existing.status === 'paid';
    let financeDate: Date | null = null;
    let financeAmount = 0;

    await this.tenantDb.db.$transaction(async (tx) => {
      const ledger = await tx.ledgerEntry.findFirst({
        where: {
          tenantId,
          linkedRecordType: 'payroll',
          linkedRecordId: id,
          deletedAt: null,
        },
        select: { date: true, amount: true },
      });
      if (ledger) {
        financeDate = ledger.date;
        financeAmount = toNumber(ledger.amount);
      }

      if (existing.invoice) {
        const invoiceId = existing.invoice.id;
        const payments = await tx.payment.findMany({
          where: { tenantId, invoiceId, deletedAt: null },
          select: { id: true, paidOn: true, amount: true },
        });
        for (const payment of payments) {
          await softDeletePaymentAccountTxns(tx, {
            tenantId,
            paymentId: payment.id,
          });
          if (!financeDate && payment.paidOn) {
            financeDate = payment.paidOn;
          }
          if (financeAmount <= 0) {
            financeAmount += toNumber(payment.amount);
          }
        }
        await tx.payment.updateMany({
          where: { tenantId, invoiceId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        await tx.accountTransaction.updateMany({
          where: { tenantId, invoiceId, deletedAt: null },
          data: { deletedAt: new Date() },
        });

        const expenses = await tx.expense.findMany({
          where: {
            tenantId,
            deletedAt: null,
            note: { contains: `payrollId:${id}` },
          },
          select: { id: true, refNo: true, totalAmount: true, expenseDate: true },
        });
        for (const expense of expenses) {
          await softDeleteExpenseAccountTxns(tx, {
            tenantId,
            expenseId: expense.id,
          });
          if (!financeDate) financeDate = expense.expenseDate;
          if (financeAmount <= 0) {
            financeAmount = toNumber(expense.totalAmount);
          }
          await tx.expense.update({
            where: { id: expense.id },
            data: {
              deletedAt: new Date(),
              refNo: expense.refNo
                ? `${expense.refNo}__del_${expense.id.slice(-8)}`
                : expense.refNo,
            },
          });
        }

        const archivedRef = `${existing.invoice.reference}__del_${id.slice(-8)}`;
        await tx.invoice.update({
          where: { id: invoiceId },
          data: {
            deletedAt: new Date(),
            reference: archivedRef,
          },
        });
      }

      await tx.ledgerEntry.updateMany({
        where: {
          tenantId,
          linkedRecordType: 'payroll',
          linkedRecordId: id,
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      });

      await tx.payroll.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    });

    if (wasPaid && financeAmount > 0) {
      void applyDailyFinanceDelta(
        this.tenantDb.db,
        tenantId,
        financeDate ?? existing.updatedAt,
        'expense',
        -financeAmount,
      );
    }

    void invalidateTenantDashboardCache(this.cache, tenantId);
    void this.cache.bumpListVersion(tenantId, 'hrm-payrolls');
    void this.cache.bumpListVersion(tenantId, 'hrm-payrolls-all');
    return { ok: true };
  }

  async updatePayrollStatus(
    id: string,
    dto: UpdatePayrollStatusRequest,
  ): Promise<Payroll> {
    const tenantId = this.tenantDb.requireTenantId();
    const nextStatus = dto.status;
    if (nextStatus !== 'draft' && nextStatus !== 'final') {
      throw new BadRequestException('status must be draft or final');
    }

    const existing = await this.tenantDb.db.payroll.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) {
      throw new BadRequestException('Payroll not found');
    }
    if (existing.paymentStatus === 'paid' || existing.status === 'paid') {
      throw new BadRequestException('Cannot change status after payroll is paid');
    }
    if (existing.status === nextStatus) {
      return this.serializePayroll(
        await this.tenantDb.db.payroll.findFirstOrThrow({
          where: { id, tenantId },
          include: {
            payrollGroup: true,
            designation: { select: { name: true } },
            employeeRecord: {
              select: {
                accountHolderName: true,
                bankName: true,
                bankBranch: true,
                bankCode: true,
                bankAccountNo: true,
                taxPayerId: true,
              },
            },
          },
        }),
      );
    }

    const row = await this.tenantDb.db.payroll.update({
      where: { id },
      data: { status: nextStatus },
      include: {
        payrollGroup: true,
        designation: { select: { name: true } },
        employeeRecord: {
          select: {
            accountHolderName: true,
            bankName: true,
            bankBranch: true,
            bankCode: true,
            bankAccountNo: true,
            taxPayerId: true,
          },
        },
      },
    });
    await this.invoiceHub.ensurePayrollInvoice(this.tenantDb.db, row);
    void invalidateTenantDashboardCache(this.cache, tenantId);
    void this.cache.bumpListVersion(tenantId, 'hrm-payrolls');
    void this.cache.bumpListVersion(tenantId, 'hrm-payrolls-all');
    return this.serializePayroll(row);
  }

  async addPayrollDeduction(
    id: string,
    dto: UpdatePayrollDeductionRequest,
  ): Promise<Payroll> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.payroll.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) {
      throw new BadRequestException('Payroll not found');
    }
    if (existing.paymentStatus === 'paid' || existing.status === 'paid') {
      throw new BadRequestException(
        'Cannot add a deduction after payroll is paid',
      );
    }

    const currentDeduction = toNumber(existing.totalDeduction);
    let nextDeduction = currentDeduction;
    if (dto.addAmount != null) {
      if (dto.addAmount < 0) {
        throw new BadRequestException('Deduction amount must be zero or more');
      }
      nextDeduction = currentDeduction + dto.addAmount;
    } else if (dto.totalDeduction != null) {
      if (dto.totalDeduction < 0) {
        throw new BadRequestException('Deduction total must be zero or more');
      }
      nextDeduction = dto.totalDeduction;
    } else {
      throw new BadRequestException('addAmount or totalDeduction is required');
    }

    const gross = toNumber(existing.grossPay);
    const allowance = toNumber(existing.totalAllowance);
    const netPay = gross + allowance - nextDeduction;
    if (netPay < 0) {
      throw new BadRequestException(
        'Deduction cannot exceed gross pay plus allowances',
      );
    }
    const reason = dto.reason?.trim();
    const label = dto.note?.trim() || 'Deduction';
    const note =
      dto.addAmount != null && dto.addAmount > 0
        ? [
            existing.note,
            reason
              ? `${label}: ${dto.addAmount} — ${reason}`
              : `${label}: ${dto.addAmount}`,
          ]
            .filter(Boolean)
            .join(' · ')
        : reason
          ? [existing.note, reason].filter(Boolean).join(' · ')
          : (dto.note?.trim() ?? existing.note);

    const row = await this.tenantDb.db.payroll.update({
      where: { id },
      data: {
        totalDeduction: nextDeduction,
        netPay,
        note,
      },
      include: {
        payrollGroup: true,
        designation: { select: { name: true } },
        employeeRecord: {
          select: {
            accountHolderName: true,
            bankName: true,
            bankBranch: true,
            bankCode: true,
            bankAccountNo: true,
            taxPayerId: true,
          },
        },
      },
    });
    await this.invoiceHub.ensurePayrollInvoice(this.tenantDb.db, row);
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return this.serializePayroll(row);
  }

  async listPayrollGroups(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    includeSummary?: boolean;
  } = {}): Promise<{
    items: PayrollGroup[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const pageLimit = filters.limit ?? 10;
    const pagination = buildCompositeCursorQuery({
      sortField: 'createdAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: pageLimit,
      sortValueType: 'date',
    });
    const baseWhere = {
      tenantId,
      deletedAt: null as null,
      ...(filters.search
        ? { name: { contains: filters.search, mode: 'insensitive' as const } }
        : {}),
    };
    const rows = await this.tenantDb.db.payrollGroup.findMany({
      where: {
        ...baseWhere,
        ...(pagination.where ?? {}),
      },
      include: {
        _count: {
          select: {
            payrolls: { where: { deletedAt: null } },
          },
        },
        payrolls: {
          where: { deletedAt: null },
          select: { netPay: true, paymentStatus: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });
    const items = rows.map((row) => this.serializePayrollGroup(row));
    if (filters.includeSummary === false) {
      return { items, hasMore: items.length >= pageLimit };
    }
    const totalCount = await this.tenantDb.db.payrollGroup.count({
      where: baseWhere,
    });
    return { items, totalCount, hasMore: items.length >= pageLimit };
  }

  async getPayrollGroupById(id: string): Promise<PayrollGroupDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.payrollGroup.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        _count: {
          select: {
            payrolls: { where: { deletedAt: null } },
          },
        },
        payrolls: {
          where: { deletedAt: null },
          select: { netPay: true, paymentStatus: true },
        },
      },
    });
    if (!row) {
      throw new BadRequestException('Payroll group not found');
    }
    const payrollRows = await this.tenantDb.db.payroll.findMany({
      where: { tenantId, payrollGroupId: id, deletedAt: null },
      include: PAYROLL_INCLUDE,
      orderBy: [{ employeeName: 'asc' }, { id: 'asc' }],
    });
    const header = this.serializePayrollGroup({
      ...row,
      payrolls: payrollRows.map((p) => ({
        netPay: p.netPay,
        paymentStatus: p.paymentStatus,
      })),
    });
    return {
      ...header,
      payrolls: payrollRows.map((r) => this.serializePayroll(r)),
    };
  }

  async createPayrollGroup(dto: CreatePayrollGroupRequest): Promise<PayrollGroup> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('Department name is required');
    }
    const createdBy = await this.auditService.createdByFields();
    const status =
      dto.status === 'final' || dto.status === 'draft' ? dto.status : 'draft';
    const row = await this.tenantDb.db.payrollGroup.create({
      data: {
        tenantId,
        name,
        code: dto.code?.trim() || null,
        description: dto.description?.trim() || null,
        locationCode: dto.locationCode?.trim() || null,
        status,
        createdByUserId: createdBy.createdByUserId ?? null,
        createdByName: createdBy.createdByName ?? null,
      },
      include: {
        _count: {
          select: {
            payrolls: { where: { deletedAt: null } },
          },
        },
        payrolls: {
          where: { deletedAt: null },
          select: { netPay: true, paymentStatus: true },
        },
      },
    });
    try {
      await this.invoiceHub.ensurePayrollGroupInvoice(this.tenantDb.db, row);
    } catch {
      // Department create should succeed even if invoice materialization fails.
    }
    return this.serializePayrollGroup(row);
  }

  async updatePayrollGroup(
    id: string,
    dto: {
      name?: string;
      code?: string | null;
      description?: string | null;
      locationCode?: string | null;
      status?: PayrollGroupStatus;
    },
  ): Promise<PayrollGroup> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.payrollGroup.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) {
      throw new BadRequestException('Department not found');
    }
    if (existing.status === 'final' && dto.status === 'draft') {
      const paidCount = await this.tenantDb.db.payroll.count({
        where: {
          tenantId,
          payrollGroupId: id,
          deletedAt: null,
          paymentStatus: 'paid',
        },
      });
      if (paidCount > 0) {
        throw new BadRequestException(
          'Cannot revert to draft when payrolls are paid',
        );
      }
    }
    const row = await this.tenantDb.db.payrollGroup.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.code !== undefined ? { code: dto.code?.trim() || null } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description?.trim() || null }
          : {}),
        ...(dto.locationCode !== undefined
          ? { locationCode: dto.locationCode?.trim() || null }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
      include: {
        _count: {
          select: {
            payrolls: { where: { deletedAt: null } },
          },
        },
        payrolls: {
          where: { deletedAt: null },
          select: { netPay: true, paymentStatus: true },
        },
      },
    });
    if (dto.status === 'final') {
      await this.tenantDb.db.payroll.updateMany({
        where: {
          tenantId,
          payrollGroupId: id,
          deletedAt: null,
          paymentStatus: { not: 'paid' },
        },
        data: { status: 'final' },
      });
    }
    return this.serializePayrollGroup(row);
  }

  async updatePayrollGroupStatus(
    id: string,
    status: PayrollGroupStatus,
  ): Promise<PayrollGroup> {
    return this.updatePayrollGroup(id, { status });
  }

  async updatePayrollGroupPayrolls(
    id: string,
    dto: UpdatePayrollGroupPayrollsRequest,
  ): Promise<PayrollGroupDetail> {
    const tenantId = this.tenantDb.requireTenantId();
    const group = await this.tenantDb.db.payrollGroup.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!group) {
      throw new BadRequestException('Payroll group not found');
    }
    await this.tenantDb.db.$transaction(async (tx) => {
      if (dto.name !== undefined || dto.locationCode !== undefined || dto.status !== undefined) {
        await tx.payrollGroup.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.locationCode !== undefined
              ? { locationCode: dto.locationCode?.trim() || null }
              : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
          },
        });
      }

      for (const emp of dto.employees) {
        const payrollId = emp.payrollId?.trim();
        if (!payrollId) continue;
        const existing = await tx.payroll.findFirst({
          where: {
            id: payrollId,
            tenantId,
            payrollGroupId: id,
            deletedAt: null,
          },
        });
        if (!existing) {
          throw new BadRequestException(`Payroll ${payrollId} not found in group`);
        }
        if (
          existing.paymentStatus === 'paid' ||
          existing.status === 'paid'
        ) {
          continue;
        }

        const allowance = emp.totalAllowance ?? toNumber(existing.totalAllowance);
        const deduction = emp.totalDeduction ?? toNumber(existing.totalDeduction);
        const grossPay = emp.grossPay ?? toNumber(existing.grossPay);
        const netPay = grossPay + allowance - deduction;
        if (netPay < 0) {
          throw new BadRequestException(
            `Net pay cannot be negative for ${existing.employeeName}`,
          );
        }

        const row = await tx.payroll.update({
          where: { id: payrollId },
          data: {
            grossPay,
            totalAllowance: allowance,
            totalDeduction: deduction,
            netPay,
            ...(emp.note !== undefined ? { note: emp.note?.trim() || null } : {}),
            ...(dto.status === 'final' ? { status: 'final' } : {}),
          },
          include: PAYROLL_INCLUDE,
        });
        await this.invoiceHub.ensurePayrollInvoice(tx, row);
      }

      if (dto.status === 'final') {
        await tx.payroll.updateMany({
          where: {
            tenantId,
            payrollGroupId: id,
            deletedAt: null,
            paymentStatus: { not: 'paid' },
          },
          data: { status: 'final' },
        });
      }
    });

    void invalidateTenantDashboardCache(this.cache, tenantId);
    void this.cache.bumpListVersion(tenantId, 'hrm-payrolls');
    void this.cache.bumpListVersion(tenantId, 'hrm-payroll-groups');
    return this.getPayrollGroupById(id);
  }

  async getPayrollPayments(id: string): Promise<PayrollPaymentRow[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const payroll = await this.tenantDb.db.payroll.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { invoice: { select: { id: true } } },
    });
    if (!payroll) {
      throw new BadRequestException('Payroll not found');
    }
    if (!payroll.invoice) {
      return [];
    }

    const payments = await this.tenantDb.db.payment.findMany({
      where: {
        tenantId,
        invoiceId: payroll.invoice.id,
        deletedAt: null,
      },
      include: { account: { select: { name: true } } },
      orderBy: [{ paidOn: 'desc' }, { id: 'desc' }],
    });

    return payments.map((p) => ({
      id: p.id,
      paidOn: p.paidOn ? toIso(p.paidOn) : null,
      paymentRefNo: p.paymentRefNo ?? null,
      amount: toNumber(p.amount),
      method: p.method ?? null,
      note: p.note ?? null,
      accountName: p.account?.name ?? null,
      authorizedByName: p.createdByName?.trim() || null,
    }));
  }

  async deletePayrollGroup(id: string): Promise<{ ok: true }> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.payrollGroup.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) {
      throw new BadRequestException('Payroll group not found');
    }
    const deletedAt = new Date();
    await this.tenantDb.db.$transaction(async (tx) => {
      await tx.payroll.updateMany({
        where: { tenantId, payrollGroupId: id, deletedAt: null },
        data: { deletedAt },
      });
      await tx.payrollGroup.update({
        where: { id },
        data: { deletedAt },
      });
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    void this.cache.bumpListVersion(tenantId, 'hrm-payrolls');
    void this.cache.bumpListVersion(tenantId, 'hrm-payroll-groups');
    return { ok: true };
  }

  async listPayComponents(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    includeSummary?: boolean;
  } = {}): Promise<{
    items: PayComponent[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const pageLimit = filters.limit ?? 10;
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: pageLimit,
      sortValueType: 'string',
    });
    const baseWhere = {
      tenantId,
      deletedAt: null as null,
      ...(filters.search
        ? { name: { contains: filters.search, mode: 'insensitive' as const } }
        : {}),
    };
    const rows = await this.tenantDb.db.payComponent.findMany({
      where: {
        ...baseWhere,
        ...(pagination.where ?? {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    const employeeIds = [
      ...new Set(
        rows
          .map((r) => r.employeeRecordId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const employees =
      employeeIds.length > 0
        ? await this.tenantDb.db.employee.findMany({
            where: { tenantId, id: { in: employeeIds }, deletedAt: null },
            select: { id: true, name: true },
          })
        : [];
    const employeeNameById = new Map(
      employees.map((e) => [e.id, e.name] as const),
    );
    const items = rows.map((row) =>
      this.serializePayComponent({
        ...row,
        employeeRecord: row.employeeRecordId
          ? {
              name:
                employeeNameById.get(row.employeeRecordId) ?? 'Unknown',
            }
          : null,
      }),
    );
    if (filters.includeSummary === false) {
      return { items, hasMore: items.length >= pageLimit };
    }
    const totalCount = await this.tenantDb.db.payComponent.count({
      where: baseWhere,
    });
    return { items, totalCount, hasMore: items.length >= pageLimit };
  }

  async createPayComponent(dto: CreatePayComponentRequest): Promise<PayComponent> {
    const tenantId = this.tenantDb.requireTenantId();
    const amountType =
      dto.amountType === 'percent' || dto.amountType === 'fixed'
        ? dto.amountType
        : 'fixed';
    const applicableDate = dto.applicableDate
      ? parseOptionalDate(dto.applicableDate)
      : null;
    const row = await this.tenantDb.db.payComponent.create({
      data: {
        tenantId,
        name: dto.name.trim(),
        type: dto.type,
        amountType,
        amount: dto.amount,
        applicableDate: applicableDate ?? null,
        employeeRecordId: dto.employeeRecordId?.trim() || null,
      },
    });
    let employeeRecord: { name: string } | null = null;
    if (row.employeeRecordId) {
      const emp = await this.tenantDb.db.employee.findFirst({
        where: { id: row.employeeRecordId, tenantId, deletedAt: null },
        select: { name: true },
      });
      employeeRecord = emp ? { name: emp.name } : null;
    }
    return this.serializePayComponent({ ...row, employeeRecord });
  }

  async updatePayComponent(
    id: string,
    dto: UpdatePayComponentRequest,
  ): Promise<PayComponent> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.payComponent.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) {
      throw new BadRequestException('Pay component not found');
    }
    const applicableDate =
      dto.applicableDate !== undefined
        ? dto.applicableDate === null
          ? null
          : parseOptionalDate(dto.applicableDate)
        : undefined;
    const row = await this.tenantDb.db.payComponent.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
        ...(dto.amountType !== undefined ? { amountType: dto.amountType } : {}),
        ...(applicableDate !== undefined
          ? { applicableDate: applicableDate ?? null }
          : {}),
        ...(dto.employeeRecordId !== undefined
          ? { employeeRecordId: dto.employeeRecordId?.trim() || null }
          : {}),
      },
    });
    let employeeRecord: { name: string } | null = null;
    if (row.employeeRecordId) {
      const emp = await this.tenantDb.db.employee.findFirst({
        where: { id: row.employeeRecordId, tenantId, deletedAt: null },
        select: { name: true },
      });
      employeeRecord = emp ? { name: emp.name } : null;
    }
    return this.serializePayComponent({ ...row, employeeRecord });
  }

  async deletePayComponent(id: string): Promise<{ ok: true }> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.payComponent.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) {
      throw new BadRequestException('Pay component not found');
    }
    await this.tenantDb.db.payComponent.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  private serializeEmployee(row: {
    id: string;
    tenantId: string;
    name: string;
    employeeCode: string | null;
    locationCode: string | null;
    locationCodes?: string[];
    payrollGroupId: string | null;
    designationId: string;
    userId: string | null;
    isServiceStaff: boolean;
    accountHolderName?: string | null;
    bankName?: string | null;
    bankBranch?: string | null;
    bankCode?: string | null;
    bankAccountNo?: string | null;
    taxPayerId?: string | null;
    mobile?: string | null;
    altContact?: string | null;
    familyContact?: string | null;
    guardianName?: string | null;
    dateOfBirth?: Date | null;
    gender?: string | null;
    maritalStatus?: string | null;
    bloodGroup?: string | null;
    idProofName?: string | null;
    idProofNumber?: string | null;
    permanentAddress?: string | null;
    currentAddress?: string | null;
    salesCommission?: { toString(): string } | number | null;
    maxSalesDiscountPercent?: { toString(): string } | number | null;
    department?: string | null;
    createdAt: Date;
    designation: { name: string };
    payrollGroup: { name: string } | null;
  }): Employee {
    const locationCodes =
      row.locationCodes && row.locationCodes.length > 0
        ? row.locationCodes
        : row.locationCode
          ? [row.locationCode]
          : [];
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      employeeCode: row.employeeCode,
      locationCode: locationCodes[0] ?? row.locationCode,
      locationCodes,
      payrollGroupId: row.payrollGroupId,
      payrollGroupName: row.payrollGroup?.name ?? null,
      designationId: row.designationId,
      designationName: row.designation.name,
      userId: row.userId,
      isServiceStaff: row.isServiceStaff,
      accountHolderName: row.accountHolderName ?? null,
      bankName: row.bankName ?? null,
      bankBranch: row.bankBranch ?? null,
      bankCode: row.bankCode ?? null,
      bankAccountNo: row.bankAccountNo ?? null,
      taxPayerId: row.taxPayerId ?? null,
      mobile: row.mobile ?? null,
      altContact: row.altContact ?? null,
      familyContact: row.familyContact ?? null,
      guardianName: row.guardianName ?? null,
      dateOfBirth: row.dateOfBirth
        ? toIso(row.dateOfBirth).slice(0, 10)
        : null,
      gender: row.gender ?? null,
      maritalStatus: row.maritalStatus ?? null,
      bloodGroup: row.bloodGroup ?? null,
      idProofName: row.idProofName ?? null,
      idProofNumber: row.idProofNumber ?? null,
      permanentAddress: row.permanentAddress ?? null,
      currentAddress: row.currentAddress ?? null,
      salesCommission:
        row.salesCommission == null ? null : toNumber(row.salesCommission),
      maxSalesDiscountPercent:
        row.maxSalesDiscountPercent == null
          ? null
          : toNumber(row.maxSalesDiscountPercent),
      department: row.department ?? null,
      createdAt: toIso(row.createdAt),
    };
  }

  private serializePayrollGroup(row: {
    id: string;
    tenantId: string;
    name: string;
    code?: string | null;
    description?: string | null;
    status: string;
    locationCode: string | null;
    createdByName: string | null;
    createdAt: Date;
    _count?: { payrolls: number };
    payrolls?: Array<{
      netPay: { toString(): string };
      paymentStatus: string;
    }>;
  }): PayrollGroup {
    const payrolls = row.payrolls ?? [];
    const totalGross = payrolls.reduce(
      (sum, p) => sum + toNumber(p.netPay),
      0,
    );
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      code: row.code ?? null,
      description: row.description ?? null,
      status: row.status === 'final' ? 'final' : 'draft',
      paymentStatus: aggregateGroupPaymentStatus(payrolls),
      totalGross,
      locationCode: row.locationCode ?? null,
      createdByName: row.createdByName ?? null,
      payrollCount: row._count?.payrolls ?? payrolls.length,
      createdAt: toIso(row.createdAt),
    };
  }

  private serializePayroll(row: {
    id: string;
    tenantId: string;
    payrollGroupId: string | null;
    employeeRecordId: string | null;
    designationId: string | null;
    employeeName: string;
    employeeId: string | null;
    locationCode: string | null;
    grossPay: { toString(): string };
    totalAllowance: { toString(): string };
    totalDeduction: { toString(): string };
    netPay: { toString(): string };
    status: string;
    paymentStatus: string;
    payrollMonth: Date;
    note: string | null;
    createdAt: Date;
    payrollGroup: { name: string } | null;
    designation?: { name: string } | null;
    tenant?: { code: string; name: string } | null;
    invoice?: { reference: string } | null;
    employeeRecord?: {
      accountHolderName: string | null;
      bankName: string | null;
      bankBranch: string | null;
      bankCode: string | null;
      bankAccountNo: string | null;
      taxPayerId: string | null;
      department?: string | null;
    } | null;
  }): Payroll {
    const bank = row.employeeRecord;
    return {
      id: row.id,
      tenantId: row.tenantId,
      tenantCode: row.tenant?.code ?? null,
      tenantName: row.tenant?.name ?? null,
      payrollGroupId: row.payrollGroupId,
      payrollGroupName: row.payrollGroup?.name ?? null,
      employeeRecordId: row.employeeRecordId,
      designationId: row.designationId,
      designationName: row.designation?.name ?? null,
      employeeName: row.employeeName,
      employeeId: row.employeeId,
      locationCode: row.locationCode,
      grossPay: toNumber(row.grossPay),
      totalAllowance: toNumber(row.totalAllowance),
      totalDeduction: toNumber(row.totalDeduction),
      netPay: toNumber(row.netPay),
      status: row.status as Payroll['status'],
      paymentStatus: row.paymentStatus,
      payrollMonth: toIso(row.payrollMonth),
      note: row.note,
      createdAt: toIso(row.createdAt),
      referenceNo: row.invoice?.reference ?? null,
      department: bank?.department ?? null,
      accountHolderName: bank?.accountHolderName ?? null,
      bankName: bank?.bankName ?? null,
      bankBranch: bank?.bankBranch ?? null,
      bankCode: bank?.bankCode ?? null,
      bankAccountNo: bank?.bankAccountNo ?? null,
      taxPayerId: bank?.taxPayerId ?? null,
    };
  }

  private serializePayComponent(row: {
    id: string;
    tenantId: string;
    name: string;
    type: string;
    amountType: string;
    amount: { toString(): string };
    applicableDate: Date | null;
    employeeRecordId: string | null;
    createdAt: Date;
    employeeRecord?: { name: string } | null;
  }): PayComponent {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      type: row.type as PayComponent['type'],
      amountType:
        row.amountType === 'percent' ? 'percent' : ('fixed' as const),
      amount: toNumber(row.amount),
      applicableDate: row.applicableDate
        ? toIso(row.applicableDate).slice(0, 10)
        : null,
      employeeRecordId: row.employeeRecordId ?? null,
      employeeName: row.employeeRecord?.name ?? null,
      createdAt: toIso(row.createdAt),
    };
  }
}

function normalizeLocationCodes(
  codes?: string[] | null,
  fallback?: string | null,
): string[] {
  const fromArray = (codes ?? [])
    .map((c) => c.trim())
    .filter(Boolean);
  if (fromArray.length > 0) {
    return [...new Set(fromArray)];
  }
  const single = fallback?.trim();
  return single ? [single] : [];
}
