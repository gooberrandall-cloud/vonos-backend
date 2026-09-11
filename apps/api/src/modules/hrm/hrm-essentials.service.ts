import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AttendanceByShiftRow,
  AttendanceRow,
  AttendanceShiftRow,
  HolidayRow,
  LeaveRow,
  LeaveTypeRow,
  SalesTargetRow,
} from '@vonos/types';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import { toIso } from '../../common/utils/serializers';

@Injectable()
export class HrmEssentialsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly cache: CacheService,
  ) {}

  async listLeaveTypes(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    includeSummary?: boolean;
  } = {}): Promise<{
    items: LeaveTypeRow[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const pageLimit = filters.limit ?? 25;
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: pageLimit,
      sortValueType: 'string',
    });
    const where = {
      tenantId,
      deletedAt: null,
      ...(filters.search
        ? { name: { contains: filters.search, mode: 'insensitive' as const } }
        : {}),
    };
    const rows = await this.tenantDb.db.leaveType.findMany({
      where: { ...where, ...(pagination.where ?? {}) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    const items = rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      maxLeaveCount: row.maxLeaveCount,
      createdAt: toIso(row.createdAt),
    }));
    if (filters.includeSummary === false) {
      return { items, hasMore: items.length >= pageLimit };
    }
    const totalCount = await this.tenantDb.db.leaveType.count({ where });
    return { items, totalCount, hasMore: items.length >= pageLimit };
  }

  async createLeaveType(dto: {
    name: string;
    maxLeaveCount?: number;
  }): Promise<LeaveTypeRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('Leave type name is required');
    const row = await this.tenantDb.db.leaveType.create({
      data: {
        tenantId,
        name,
        maxLeaveCount: Math.max(0, Number(dto.maxLeaveCount) || 0),
      },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      maxLeaveCount: row.maxLeaveCount,
      createdAt: toIso(row.createdAt),
    };
  }

  async updateLeaveType(
    id: string,
    dto: { name?: string; maxLeaveCount?: number },
  ): Promise<LeaveTypeRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.leaveType.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Leave type not found');
    const row = await this.tenantDb.db.leaveType.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.maxLeaveCount !== undefined
          ? { maxLeaveCount: Math.max(0, Number(dto.maxLeaveCount) || 0) }
          : {}),
      },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      maxLeaveCount: row.maxLeaveCount,
      createdAt: toIso(row.createdAt),
    };
  }

  async deleteLeaveType(id: string): Promise<{ ok: true }> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.leaveType.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Leave type not found');
    await this.tenantDb.db.leaveType.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  async listLeaves(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    designationId?: string;
    includeSummary?: boolean;
  } = {}): Promise<{
    items: LeaveRow[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      designationId: filters.designationId,
      cursor: filters.cursor,
      limit: filters.limit ?? 25,
      sum: filters.includeSummary === false ? 0 : 1,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'hrm-leaves',
      filterKey,
      () => this.listLeavesUncached(filters, tenantId),
    );
  }

  private async listLeavesUncached(
    filters: {
      cursor?: string;
      limit?: number;
      search?: string;
      designationId?: string;
      includeSummary?: boolean;
    },
    tenantId: string,
  ): Promise<{
    items: LeaveRow[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const pageLimit = filters.limit ?? 25;
    const pagination = buildCompositeCursorQuery({
      sortField: 'leaveDate',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: pageLimit,
      sortValueType: 'date',
    });
    const where = {
      tenantId,
      deletedAt: null,
      ...(filters.designationId
        ? { designationId: filters.designationId }
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
                referenceNo: {
                  contains: filters.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                reason: {
                  contains: filters.search,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };
    const rows = await this.tenantDb.db.leave.findMany({
      where: { ...where, ...(pagination.where ?? {}) },
      include: { leaveType: { select: { name: true } } },
      orderBy: [{ leaveDate: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });
    const items = rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      referenceNo: row.referenceNo,
      leaveTypeId: row.leaveTypeId,
      leaveTypeName: row.leaveType?.name ?? null,
      employeeName: row.employeeName,
      employeeRecordId: row.employeeRecordId,
      designationId: row.designationId,
      leaveDate: toIso(row.leaveDate),
      reason: row.reason,
      status: row.status,
      createdAt: toIso(row.createdAt),
    }));
    if (filters.includeSummary === false) {
      return { items, hasMore: items.length >= pageLimit };
    }
    const totalCount = await this.tenantDb.db.leave.count({ where });
    return { items, totalCount, hasMore: items.length >= pageLimit };
  }

  async createLeave(dto: {
    referenceNo?: string;
    leaveTypeId?: string;
    employeeName: string;
    employeeRecordId?: string;
    designationId?: string;
    leaveDate: string;
    reason?: string;
    status?: string;
  }): Promise<LeaveRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const employeeName = dto.employeeName?.trim();
    if (!employeeName) throw new BadRequestException('Employee is required');
    if (!dto.leaveDate) throw new BadRequestException('Leave date is required');
    const row = await this.tenantDb.db.leave.create({
      data: {
        tenantId,
        referenceNo: dto.referenceNo?.trim() || null,
        leaveTypeId: dto.leaveTypeId || null,
        employeeName,
        employeeRecordId: dto.employeeRecordId || null,
        designationId: dto.designationId || null,
        leaveDate: new Date(dto.leaveDate),
        reason: dto.reason?.trim() || null,
        status: dto.status?.trim() || 'pending',
      },
      include: { leaveType: { select: { name: true } } },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return {
      id: row.id,
      tenantId: row.tenantId,
      referenceNo: row.referenceNo,
      leaveTypeId: row.leaveTypeId,
      leaveTypeName: row.leaveType?.name ?? null,
      employeeName: row.employeeName,
      employeeRecordId: row.employeeRecordId,
      designationId: row.designationId,
      leaveDate: toIso(row.leaveDate),
      reason: row.reason,
      status: row.status,
      createdAt: toIso(row.createdAt),
    };
  }

  async deleteLeave(id: string): Promise<{ ok: true }> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.leave.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Leave not found');
    await this.tenantDb.db.leave.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  async listHolidays(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    includeSummary?: boolean;
  } = {}): Promise<{
    items: HolidayRow[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const pageLimit = filters.limit ?? 25;
    const pagination = buildCompositeCursorQuery({
      sortField: 'date',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: pageLimit,
      sortValueType: 'date',
    });
    const where = {
      tenantId,
      deletedAt: null,
      ...(filters.search
        ? {
            OR: [
              {
                name: {
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
            ],
          }
        : {}),
    };
    const rows = await this.tenantDb.db.holiday.findMany({
      where: { ...where, ...(pagination.where ?? {}) },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });
    const items = rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      date: toIso(row.date),
      locationCode: row.locationCode,
      note: row.note,
      createdAt: toIso(row.createdAt),
    }));
    if (filters.includeSummary === false) {
      return { items, hasMore: items.length >= pageLimit };
    }
    const totalCount = await this.tenantDb.db.holiday.count({ where });
    return { items, totalCount, hasMore: items.length >= pageLimit };
  }

  async createHoliday(dto: {
    name: string;
    date: string;
    locationCode?: string;
    note?: string;
  }): Promise<HolidayRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('Holiday name is required');
    if (!dto.date) throw new BadRequestException('Date is required');
    const row = await this.tenantDb.db.holiday.create({
      data: {
        tenantId,
        name,
        date: new Date(dto.date),
        locationCode: dto.locationCode?.trim() || null,
        note: dto.note?.trim() || null,
      },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      date: toIso(row.date),
      locationCode: row.locationCode,
      note: row.note,
      createdAt: toIso(row.createdAt),
    };
  }

  async deleteHoliday(id: string): Promise<{ ok: true }> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.holiday.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Holiday not found');
    await this.tenantDb.db.holiday.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  async listShifts(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    includeSummary?: boolean;
  } = {}): Promise<{
    items: AttendanceShiftRow[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const pageLimit = filters.limit ?? 25;
    const pagination = buildCompositeCursorQuery({
      sortField: 'name',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: pageLimit,
      sortValueType: 'string',
    });
    const where = {
      tenantId,
      deletedAt: null,
      ...(filters.search
        ? { name: { contains: filters.search, mode: 'insensitive' as const } }
        : {}),
    };
    const rows = await this.tenantDb.db.attendanceShift.findMany({
      where: { ...where, ...(pagination.where ?? {}) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    const items = rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      createdAt: toIso(row.createdAt),
    }));
    if (filters.includeSummary === false) {
      return { items, hasMore: items.length >= pageLimit };
    }
    const totalCount = await this.tenantDb.db.attendanceShift.count({ where });
    return { items, totalCount, hasMore: items.length >= pageLimit };
  }

  async createShift(dto: { name: string }): Promise<AttendanceShiftRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('Shift name is required');
    const row = await this.tenantDb.db.attendanceShift.create({
      data: { tenantId, name },
    });
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      createdAt: toIso(row.createdAt),
    };
  }

  async listAttendances(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    date?: string;
    includeSummary?: boolean;
  } = {}): Promise<{
    items: AttendanceRow[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      date: filters.date,
      cursor: filters.cursor,
      limit: filters.limit ?? 25,
      sum: filters.includeSummary === false ? 0 : 1,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'hrm-attendance',
      filterKey,
      () => this.listAttendancesUncached(filters, tenantId),
    );
  }

  private async listAttendancesUncached(
    filters: {
      cursor?: string;
      limit?: number;
      search?: string;
      date?: string;
      includeSummary?: boolean;
    },
    tenantId: string,
  ): Promise<{
    items: AttendanceRow[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const pageLimit = filters.limit ?? 25;
    const pagination = buildCompositeCursorQuery({
      sortField: 'date',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: pageLimit,
      sortValueType: 'date',
    });
    const day = filters.date ? new Date(filters.date) : undefined;
    const where = {
      tenantId,
      deletedAt: null,
      ...(day ? { date: day } : {}),
      ...(filters.search
        ? {
            employeeName: {
              contains: filters.search,
              mode: 'insensitive' as const,
            },
          }
        : {}),
    };
    const rows = await this.tenantDb.db.attendance.findMany({
      where: { ...where, ...(pagination.where ?? {}) },
      include: { shift: { select: { name: true } } },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });
    const items = rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      employeeName: row.employeeName,
      shiftId: row.shiftId,
      shiftName: row.shift?.name ?? null,
      date: toIso(row.date),
      clockIn: row.clockIn ? toIso(row.clockIn) : null,
      clockOut: row.clockOut ? toIso(row.clockOut) : null,
      status: row.status,
      createdAt: toIso(row.createdAt),
    }));
    if (filters.includeSummary === false) {
      return { items, hasMore: items.length >= pageLimit };
    }
    const totalCount = await this.tenantDb.db.attendance.count({ where });
    return { items, totalCount, hasMore: items.length >= pageLimit };
  }

  async attendanceByShift(date: string): Promise<AttendanceByShiftRow[]> {
    const tenantId = this.tenantDb.requireTenantId();
    if (!date) throw new BadRequestException('Date is required');
    const day = new Date(date);
    const shifts = await this.tenantDb.db.attendanceShift.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    const rows = await this.tenantDb.db.attendance.findMany({
      where: { tenantId, deletedAt: null, date: day },
      select: { shiftId: true, status: true },
    });
    return shifts.map((shift) => {
      const forShift = rows.filter((r) => r.shiftId === shift.id);
      return {
        id: shift.id,
        shift: shift.name,
        present: forShift.filter((r) => r.status === 'present').length,
        absent: forShift.filter((r) => r.status === 'absent').length,
      };
    });
  }

  async clockIn(dto: {
    employeeName: string;
    shiftId?: string;
    date?: string;
  }): Promise<AttendanceRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const employeeName = dto.employeeName?.trim();
    if (!employeeName) throw new BadRequestException('Employee is required');
    const now = new Date();
    const day = dto.date ? new Date(dto.date) : new Date(now.toISOString().slice(0, 10));
    const row = await this.tenantDb.db.attendance.create({
      data: {
        tenantId,
        employeeName,
        shiftId: dto.shiftId || null,
        date: day,
        clockIn: now,
        status: 'present',
      },
      include: { shift: { select: { name: true } } },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return {
      id: row.id,
      tenantId: row.tenantId,
      employeeName: row.employeeName,
      shiftId: row.shiftId,
      shiftName: row.shift?.name ?? null,
      date: toIso(row.date),
      clockIn: row.clockIn ? toIso(row.clockIn) : null,
      clockOut: row.clockOut ? toIso(row.clockOut) : null,
      status: row.status,
      createdAt: toIso(row.createdAt),
    };
  }

  async listSalesTargets(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    includeSummary?: boolean;
  } = {}): Promise<{
    items: SalesTargetRow[];
    totalCount?: number;
    hasMore?: boolean;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const pageLimit = filters.limit ?? 25;
    const pagination = buildCompositeCursorQuery({
      sortField: 'userName',
      sortDir: 'asc',
      cursor: filters.cursor,
      limit: pageLimit,
      sortValueType: 'string',
    });
    const where = {
      tenantId,
      deletedAt: null,
      ...(filters.search
        ? {
            userName: {
              contains: filters.search,
              mode: 'insensitive' as const,
            },
          }
        : {}),
    };
    const rows = await this.tenantDb.db.salesTarget.findMany({
      where: { ...where, ...(pagination.where ?? {}) },
      orderBy: [{ userName: 'asc' }, { id: 'asc' }],
      take: pagination.take,
    });
    const items = rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      userName: row.userName,
      userId: row.userId,
      createdAt: toIso(row.createdAt),
    }));
    if (filters.includeSummary === false) {
      return { items, hasMore: items.length >= pageLimit };
    }
    const totalCount = await this.tenantDb.db.salesTarget.count({ where });
    return { items, totalCount, hasMore: items.length >= pageLimit };
  }

  async upsertSalesTarget(dto: {
    userName: string;
    userId?: string;
    note?: string;
  }): Promise<SalesTargetRow> {
    const tenantId = this.tenantDb.requireTenantId();
    const userName = dto.userName?.trim();
    if (!userName) throw new BadRequestException('User is required');
    const existing = await this.tenantDb.db.salesTarget.findFirst({
      where: { tenantId, deletedAt: null, userName },
    });
    const row = existing
      ? await this.tenantDb.db.salesTarget.update({
          where: { id: existing.id },
          data: {
            userId: dto.userId ?? existing.userId,
            note: dto.note?.trim() ?? existing.note,
          },
        })
      : await this.tenantDb.db.salesTarget.create({
          data: {
            tenantId,
            userName,
            userId: dto.userId || null,
            note: dto.note?.trim() || null,
          },
        });
    return {
      id: row.id,
      tenantId: row.tenantId,
      userName: row.userName,
      userId: row.userId,
      createdAt: toIso(row.createdAt),
    };
  }
}
