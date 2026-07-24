import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type {
  PayComponent,
  Payroll,
  PayrollGroup,
  Designation,
  Employee,
  WorkforceMember,
  CreatePayrollRequest,
  CreatePayrollGroupRequest,
  CreatePayComponentRequest,
  CreateDesignationRequest,
  CreateEmployeeRequest,
  UpdatePayrollDeductionRequest,
  PayrollFilters,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import { resolveListSort } from '../../common/utils/listSort';
import { toIso, toNumber } from '../../common/utils/serializers';
import { isServiceStaffDesignation } from '../../common/utils/serviceStaffDesignations';
import { InvoiceHubService } from '../invoices/invoice-hub.service';
import { CacheService } from '../../common/cache/cache.service';

@Injectable()
export class HrmService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly invoiceHub: InvoiceHubService,
    private readonly cache: CacheService,
  ) {}

  async listWorkforce(
    filters: { search?: string; cursor?: string; limit?: number } = {},
  ): Promise<WorkforceMember[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const cacheKey = await this.cache.tenantScopedKey(
      tenantId,
      `workforce:dashboard:${filters.search ?? ''}:${filters.cursor ?? ''}:${filters.limit ?? ''}`,
    );
    const cached = await this.cache.get<WorkforceMember[]>(cacheKey);
    if (cached) return cached;

    const result = await this.queryWorkforce({
      tenantId,
      search: filters.search,
      cursor: filters.cursor,
      limit: filters.limit,
    });
    await this.cache.set(cacheKey, result, 900);
    return result;
  }

  async listWorkforceAllTenants(
    requestRole: string,
    filters: { search?: string; cursor?: string; limit?: number } = {},
  ): Promise<WorkforceMember[]> {
    if (requestRole !== 'super_admin') {
      throw new ForbiddenException('Super admin access required');
    }
    return this.queryWorkforce({
      search: filters.search,
      cursor: filters.cursor,
      limit: filters.limit,
    });
  }

  private async queryWorkforce(options: {
    tenantId?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  }): Promise<WorkforceMember[]> {
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: options.cursor,
      limit: options.limit ?? 10,
      sortValueType: 'string',
    });
    const employees = await this.tenantDb.db.employee.findMany({
      where: {
        deletedAt: null,
        ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        ...(options.search?.trim()
          ? {
              name: {
                contains: options.search.trim(),
                mode: 'insensitive' as const,
              },
            }
          : {}),
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

    if (employees.length > 0) {
      const employeeIds = employees.map((row) => row.id);
      const netPayAgg = await this.tenantDb.db.payroll.groupBy({
        by: ['employeeRecordId'],
        where: {
          deletedAt: null,
          employeeRecordId: { in: employeeIds },
        },
        _sum: { netPay: true },
      });
      const netByEmployee = new Map(
        netPayAgg
          .filter((row) => row.employeeRecordId != null)
          .map((row) => [
            row.employeeRecordId as string,
            toNumber(row._sum.netPay ?? 0),
          ]),
      );

      return employees.map((row) => {
        const lastPayroll = row.payrolls[0];
        return {
          id: row.id,
          tenantId: row.tenantId,
          tenantCode: row.tenant.code,
          tenantName: row.tenant.name,
          employeeName: row.name,
          employeeId: row.employeeCode,
          locationCode: row.locationCode,
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
    }

    // Fallback: derive roster from payroll history when Employee rows are absent
    return this.queryWorkforceFromPayroll(options);
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
      const key = `${row.tenantId}::${row.employeeName}`;
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          id: key,
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
  } = {}): Promise<Designation[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'string',
    });
    const rows = await this.tenantDb.db.designation.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(pagination.where ?? {}),
      },
      include: { _count: { select: { employees: true } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      employeeCount: row._count.employees,
      createdAt: toIso(row.createdAt),
    }));
  }

  async createDesignation(dto: CreateDesignationRequest): Promise<Designation> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('Designation name is required');
    }
    const row = await this.tenantDb.db.designation.create({
      data: { tenantId, name },
      include: { _count: { select: { employees: true } } },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      employeeCount: row._count.employees,
      createdAt: toIso(row.createdAt),
    };
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
          ? { locationCode: filters.locationCode }
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
      dto.isServiceStaff ?? isServiceStaffDesignation(designation.name);

    const row = await this.tenantDb.db.employee.create({
      data: {
        tenantId,
        name,
        employeeCode: dto.employeeCode?.trim() || null,
        locationCode: dto.locationCode?.trim() || null,
        payrollGroupId: dto.payrollGroupId?.trim() || null,
        designationId: dto.designationId,
        userId: dto.userId?.trim() || null,
        isServiceStaff,
      },
      include: {
        designation: { select: { name: true } },
        payrollGroup: { select: { name: true } },
      },
    });
    return this.serializeEmployee(row);
  }

  async listPayrolls(filters: PayrollFilters = {}): Promise<Payroll[]> {
    const tenantId = this.tenantDb.requireTenantId();
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
    const rows = await this.tenantDb.db.payroll.findMany({
      where: {
        tenantId,
        deletedAt: null,
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
        ...(filters.search
          ? {
              employeeName: {
                contains: filters.search,
                mode: 'insensitive',
              },
            }
          : {}),
        ...(pagination.where ?? {}),
      },
      include: {
        payrollGroup: true,
        designation: { select: { name: true } },
      },
      orderBy: [{ [sort.sortField]: sort.sortDir }, { id: sort.sortDir }],
      take: pagination.take,
    });
    return rows.map((row) => this.serializePayroll(row));
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

    if (dto.employeeRecordId) {
      const employee = await this.tenantDb.db.employee.findFirst({
        where: {
          id: dto.employeeRecordId,
          tenantId,
          deletedAt: null,
        },
      });
      if (!employee) {
        throw new BadRequestException('Employee not found');
      }
      employeeRecordId = employee.id;
      employeeName = employee.name;
      employeeId = employee.employeeCode;
      designationId = employee.designationId;
      payrollGroupId = employee.payrollGroupId ?? payrollGroupId;
      locationCode = employee.locationCode ?? locationCode;
    }

    if (!employeeName) {
      throw new BadRequestException(
        'employeeRecordId or employeeName is required',
      );
    }
    if (!designationId) {
      throw new BadRequestException('Designation is required');
    }

    const designation = await this.tenantDb.db.designation.findFirst({
      where: { id: designationId, tenantId, deletedAt: null },
    });
    if (!designation) {
      throw new BadRequestException('Designation not found');
    }

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
        payrollMonth: new Date(dto.payrollMonth),
        note: dto.note ?? null,
      },
      include: {
        payrollGroup: true,
        designation: { select: { name: true } },
      },
    });
    await this.invoiceHub.ensurePayrollInvoice(this.tenantDb.db, row);
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
      },
    });
    await this.invoiceHub.ensurePayrollInvoice(this.tenantDb.db, row);
    return this.serializePayroll(row);
  }

  async listPayrollGroups(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
  } = {}): Promise<PayrollGroup[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'string',
    });
    const rows = await this.tenantDb.db.payrollGroup.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(pagination.where ?? {}),
      },
      include: { _count: { select: { payrolls: true } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      payrollCount: row._count.payrolls,
      createdAt: toIso(row.createdAt),
    }));
  }

  async createPayrollGroup(dto: CreatePayrollGroupRequest): Promise<PayrollGroup> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('Department name is required');
    }
    const row = await this.tenantDb.db.payrollGroup.create({
      data: { tenantId, name },
      include: { _count: { select: { payrolls: true } } },
    });
    try {
      await this.invoiceHub.ensurePayrollGroupInvoice(this.tenantDb.db, row);
    } catch {
      // Department create should succeed even if invoice materialization fails.
    }
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      payrollCount: row._count.payrolls,
      createdAt: toIso(row.createdAt),
    };
  }

  async listPayComponents(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
  } = {}): Promise<PayComponent[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'string',
    });
    const rows = await this.tenantDb.db.payComponent.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' } }
          : {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      type: row.type as PayComponent['type'],
      amount: toNumber(row.amount),
      createdAt: toIso(row.createdAt),
    }));
  }

  async createPayComponent(dto: CreatePayComponentRequest): Promise<PayComponent> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.payComponent.create({
      data: {
        tenantId,
        name: dto.name,
        type: dto.type,
        amount: dto.amount,
      },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      type: row.type as PayComponent['type'],
      amount: toNumber(row.amount),
      createdAt: toIso(row.createdAt),
    };
  }

  private serializeEmployee(row: {
    id: string;
    tenantId: string;
    name: string;
    employeeCode: string | null;
    locationCode: string | null;
    payrollGroupId: string | null;
    designationId: string;
    userId: string | null;
    isServiceStaff: boolean;
    createdAt: Date;
    designation: { name: string };
    payrollGroup: { name: string } | null;
  }): Employee {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      employeeCode: row.employeeCode,
      locationCode: row.locationCode,
      payrollGroupId: row.payrollGroupId,
      payrollGroupName: row.payrollGroup?.name ?? null,
      designationId: row.designationId,
      designationName: row.designation.name,
      userId: row.userId,
      isServiceStaff: row.isServiceStaff,
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
  }): Payroll {
    return {
      id: row.id,
      tenantId: row.tenantId,
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
    };
  }
}
