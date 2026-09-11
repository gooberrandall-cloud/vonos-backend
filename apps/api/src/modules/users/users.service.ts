import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { InviteUserResponse, User } from '@vonos/types';
import { mapTenantRoleToJwtRole, ROLES } from '@vonos/types';
import type { AuthenticatedUser } from '../../common/decorators/roles.decorator';
import { generateOpaqueToken } from '../../common/utils/auth-token';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import { devPasswordHash, hashPassword, isStrongPassword, STRONG_PASSWORD_HINT } from '../../common/utils/password';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateUserAuthSession } from '../../common/cache/authSessionInvalidation';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import { toIso } from '../../common/utils/serializers';
import { resolvePrimaryWebOrigin } from '../../common/utils/webOrigin';
import { isServiceStaffEligible } from '../../common/utils/serviceStaffDesignations';
import { AuthMailService } from '../auth/auth-mail.service';
import { INVITE_DAYS } from '../auth/auth.constants';
import {
  relationStringOr,
  tokenizedSearchWhere,
} from '../../common/utils/listSearch';
import { locationCodesForTenantCode } from '../../common/utils/workLocationTenantCodes';
import { assertVagPortalAccess } from '../../common/utils/vagPortalAccess';

/** Synthetic scope for unscoped VAG all-tenants user list cache. */
const VAG_USERS_CACHE_SCOPE = '__vag__';

export interface UserListRow extends User {
  tenantCode?: string | null;
  tenantName?: string | null;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly mail: AuthMailService,
    private readonly cache: CacheService,
  ) {}

  private invalidateUserCaches(tenantId: string | null): void {
    void invalidateTenantDashboardCache(this.cache, VAG_USERS_CACHE_SCOPE);
    if (tenantId) {
      void invalidateTenantDashboardCache(this.cache, tenantId);
    }
  }

  /** User ids with Employee work-location clearance for this tenant. */
  private async userIdsWithClearanceForTenant(
    tenantId: string,
  ): Promise<string[]> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { code: true },
    });
    const aliases = locationCodesForTenantCode(tenant?.code);
    if (aliases.length === 0) return [];

    const employees = await this.prisma.employee.findMany({
      where: {
        deletedAt: null,
        userId: { not: null },
        OR: [
          { locationCodes: { hasSome: aliases } },
          { locationCode: { in: aliases } },
        ],
      },
      select: { userId: true },
    });
    return [
      ...new Set(
        employees
          .map((row) => row.userId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
  }

  private async userHasClearanceForTenant(
    userId: string,
    tenantId: string,
  ): Promise<boolean> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { code: true },
    });
    const aliases = locationCodesForTenantCode(tenant?.code);
    if (aliases.length === 0) return false;

    const employee = await this.prisma.employee.findFirst({
      where: {
        userId,
        deletedAt: null,
        OR: [
          { locationCodes: { hasSome: aliases } },
          { locationCode: { in: aliases } },
        ],
      },
      select: { id: true },
    });
    return Boolean(employee);
  }

  async listForTenant(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    role?: string;
    status?: string;
  } = {}): Promise<UserListRow[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const filterKey = listPageFilterKey({
      search: filters.search,
      role: filters.role,
      status: filters.status,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
    });
    return withListPageCache(
      this.cache,
      tenantId,
      'users:v2',
      filterKey,
      () => this.listForTenantUncached(filters, tenantId),
    );
  }

  private async listForTenantUncached(
    filters: {
      cursor?: string;
      limit?: number;
      search?: string;
      role?: string;
      status?: string;
    },
    tenantId: string,
  ): Promise<UserListRow[]> {
    const [legacyLinks, clearanceUserIds, tenant] = await Promise.all([
      this.prisma.migrationLegacyId.findMany({
        where: { tenantId, entityType: 'user' },
        select: { newId: true },
      }),
      this.userIdsWithClearanceForTenant(tenantId),
      this.prisma.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
        select: { code: true, name: true },
      }),
    ]);
    const legacyUserIds = legacyLinks.map((link) => link.newId);

    const pagination = buildCompositeCursorQuery({
      sortField: 'createdAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const rows = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(filters.role ? { role: filters.role as User['role'] } : {}),
        ...(filters.status ? { status: filters.status as User['status'] } : {}),
        AND: [
          {
            OR: [
              { tenantId },
              ...(clearanceUserIds.length > 0
                ? [{ id: { in: clearanceUserIds } }]
                : []),
              ...(legacyUserIds.length > 0
                ? [{ id: { in: legacyUserIds } }]
                : []),
            ],
          },
          ...(filters.search
            ? [
                tokenizedSearchWhere(filters.search, (_token, contains) => [
                  { name: contains },
                  { email: contains },
                ])!,
              ]
            : []),
        ],
        ...(pagination.where ?? {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
      include: {
        tenantRole: { select: { id: true, name: true } },
        tenant: { select: { code: true, name: true } },
      },
    });

    return rows.map((row) => {
      const base = this.toUser(row);
      const homeCode = row.tenant?.code ?? null;
      const homeName = row.tenant?.name ?? null;
      // Surface home entity when this row is a clearance guest on another entity.
      if (homeCode && homeCode !== tenant?.code) {
        return {
          ...base,
          tenantCode: homeCode,
          tenantName: homeName,
        };
      }
      return {
        ...base,
        tenantCode: homeCode ?? tenant?.code ?? null,
        tenantName: homeName ?? tenant?.name ?? null,
      };
    });
  }

  /**
   * Single user for detail pages — tenant-scoped, including legacy-linked users
   * and multi-entity staff with work-location clearance for this tenant.
   * Super-admin may always load by id (VAG users list is cross-entity; an active
   * "viewing" tenant must not 404 users from other entities).
   */
  async getById(id: string, actor?: AuthenticatedUser): Promise<User> {
    if (actor?.role === 'super_admin') {
      const row = await this.prisma.user.findFirst({
        where: { id, deletedAt: null },
        include: {
          tenantRole: { select: { id: true, name: true } },
        },
      });
      if (!row) throw new NotFoundException('User not found');
      return this.toUser(row);
    }

    const tenantId = this.tenantDb.requireTenantId();
    const [legacyLink, hasClearance] = await Promise.all([
      this.prisma.migrationLegacyId.findFirst({
        where: { tenantId, entityType: 'user', newId: id },
        select: { newId: true },
      }),
      this.userHasClearanceForTenant(id, tenantId),
    ]);

    const row = await this.prisma.user.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [
          { tenantId },
          ...(hasClearance || legacyLink ? [{ id }] : []),
        ],
      },
      include: {
        tenantRole: { select: { id: true, name: true } },
      },
    });
    if (!row) throw new NotFoundException('User not found');
    if (row.tenantId !== tenantId && !legacyLink && !hasClearance) {
      throw new NotFoundException('User not found');
    }
    return this.toUser(row);
  }

  async listAllTenants(
    requestUser: AuthenticatedUser,
    filters: {
      cursor?: string;
      limit?: number;
      search?: string;
      role?: string;
      status?: string;
    } = {},
  ): Promise<UserListRow[]> {
    assertVagPortalAccess(requestUser);

    const filterKey = listPageFilterKey({
      search: filters.search,
      role: filters.role,
      status: filters.status,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
    });
    return withListPageCache(
      this.cache,
      VAG_USERS_CACHE_SCOPE,
      'users-all',
      filterKey,
      () => this.listAllTenantsUncached(filters),
    );
  }

  private async listAllTenantsUncached(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    role?: string;
    status?: string;
  }): Promise<UserListRow[]> {
    const pagination = buildCompositeCursorQuery({
      sortField: 'createdAt',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const rows = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(filters.role ? { role: filters.role as User['role'] } : {}),
        ...(filters.status ? { status: filters.status as User['status'] } : {}),
        ...(filters.search
          ? tokenizedSearchWhere(filters.search, (_token, contains) => [
              { name: contains },
              { email: contains },
              relationStringOr('tenant', 'name', contains),
              relationStringOr('tenant', 'code', contains),
            ])
          : {}),
        ...(pagination.where ?? {}),
      },
      include: {
        tenant: { select: { code: true, name: true } },
        tenantRole: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });

    const unscopedIds = rows
      .filter((row) => row.tenantId === null)
      .map((row) => row.id);
    const legacyOrigins =
      unscopedIds.length > 0
        ? await this.prisma.migrationLegacyId.findMany({
            where: { entityType: 'user', newId: { in: unscopedIds } },
            include: { tenant: { select: { code: true, name: true } } },
          })
        : [];
    const homeTenantByUserId = new Map(
      legacyOrigins.map((link) => [link.newId, link.tenant]),
    );

    return rows.map((row) => {
      const homeTenant = row.tenant ?? homeTenantByUserId.get(row.id) ?? null;
      const isGroupOnly =
        row.tenantId === null && row.role === 'super_admin' && !homeTenant;

      return {
        ...this.toUser(row),
        tenantCode: homeTenant?.code ?? (isGroupOnly ? 'VAG' : null),
        tenantName:
          homeTenant?.name ?? (isGroupOnly ? 'Vonos Autos Group' : null),
      };
    });
  }

  async inviteUser(
    actor: AuthenticatedUser,
    body: {
      email: string;
      name: string;
      role: User['role'];
      tenantRoleId?: string | null;
      tenantId?: string | null;
    },
  ): Promise<InviteUserResponse> {
    const assignment = await this.resolveUserAssignment(actor, body);
    const roleBinding = await this.resolveTenantRoleBinding(
      assignment.targetTenantId,
      body.tenantRoleId,
      assignment.role,
    );

    const existing = await this.prisma.user.findFirst({
      where: {
        email: { equals: assignment.email, mode: 'insensitive' },
        deletedAt: null,
      },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const { raw, hash } = generateOpaqueToken();
    const user = await this.prisma.user.create({
      data: {
        email: assignment.email,
        username: await this.resolveUniqueUsername(undefined, assignment.email),
        name: assignment.name,
        role: roleBinding.jwtRole,
        tenantRoleId: roleBinding.tenantRoleId,
        status: 'invited',
        tenantId: assignment.targetTenantId,
        passwordHash: devPasswordHash('invite-placeholder-not-for-login'),
      },
      include: {
        tenantRole: { select: { id: true, name: true } },
      },
    });

    await this.prisma.authToken.create({
      data: {
        userId: user.id,
        type: 'invite',
        tokenHash: hash,
        expiresAt: this.daysFromNow(INVITE_DAYS),
      },
    });

    const webOrigin = resolvePrimaryWebOrigin();
    const inviteUrl = `${webOrigin}/invite/${raw}`;
    this.mail.sendInvite(assignment.email, inviteUrl);

    this.invalidateUserCaches(assignment.targetTenantId);

    const response: InviteUserResponse = { user: this.toUser(user) };
    if (process.env.NODE_ENV !== 'production') {
      response.devInviteUrl = inviteUrl;
    }
    return response;
  }

  async createUser(
    actor: AuthenticatedUser,
    body: {
      email: string;
      name: string;
      role: User['role'];
      password: string;
      username?: string | null;
      tenantRoleId?: string | null;
      tenantId?: string | null;
    },
  ): Promise<{ user: User }> {
    const assignment = await this.resolveUserAssignment(actor, body);
    const roleBinding = await this.resolveTenantRoleBinding(
      assignment.targetTenantId,
      body.tenantRoleId,
      assignment.role,
    );

    if (!body.password || !isStrongPassword(body.password)) {
      throw new BadRequestException(STRONG_PASSWORD_HINT);
    }

    const existing = await this.prisma.user.findFirst({
      where: {
        email: { equals: assignment.email, mode: 'insensitive' },
        deletedAt: null,
      },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const username = await this.resolveUniqueUsername(
      body.username,
      assignment.email,
    );

    const passwordHash = await hashPassword(body.password);
    const user = await this.prisma.user.create({
      data: {
        email: assignment.email,
        username,
        name: assignment.name,
        role: roleBinding.jwtRole,
        tenantRoleId: roleBinding.tenantRoleId,
        status: 'active',
        tenantId: assignment.targetTenantId,
        passwordHash,
      },
      include: {
        tenantRole: { select: { id: true, name: true } },
      },
    });

    this.invalidateUserCaches(assignment.targetTenantId);
    return { user: this.toUser(user) };
  }

  async updateUser(
    actor: AuthenticatedUser,
    id: string,
    body: {
      email?: string;
      name?: string;
      role?: User['role'];
      username?: string | null;
      tenantRoleId?: string | null;
      status?: User['status'];
      password?: string;
    },
  ): Promise<{ user: User }> {
    const row = await this.findManagedUser(actor, id);

    const data: {
      email?: string;
      name?: string;
      username?: string | null;
      role?: User['role'];
      tenantRoleId?: string | null;
      status?: User['status'];
      passwordHash?: string;
      tokenVersion?: { increment: number };
    } = {};

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) throw new BadRequestException('Name is required');
      data.name = name;
    }

    if (body.email !== undefined) {
      const email = body.email.trim().toLowerCase();
      if (!email) throw new BadRequestException('Email is required');
      const clash = await this.prisma.user.findFirst({
        where: {
          email: { equals: email, mode: 'insensitive' },
          deletedAt: null,
          NOT: { id: row.id },
        },
      });
      if (clash) {
        throw new ConflictException('A user with this email already exists');
      }
      data.email = email;
    }

    if (body.username !== undefined) {
      if (body.username === null || body.username.trim() === '') {
        data.username = null;
      } else {
        data.username = await this.resolveUniqueUsername(
          body.username,
          body.email ?? row.email,
          row.id,
        );
      }
    }

    if (body.tenantRoleId !== undefined) {
      const roleBinding = await this.resolveTenantRoleBinding(
        row.tenantId,
        body.tenantRoleId,
        body.role ?? row.role,
      );
      data.tenantRoleId = roleBinding.tenantRoleId;
      data.role = roleBinding.jwtRole;
      // Force session refresh so the UI picks up the new role matrix.
      data.tokenVersion = { increment: 1 };
    } else if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) {
        throw new BadRequestException('Invalid role');
      }
      if (actor.role === 'admin') {
        const allowed: User['role'][] = ['manager', 'staff', 'viewer'];
        if (!allowed.includes(body.role)) {
          throw new ForbiddenException('Cannot assign this role');
        }
      }
      if (body.role === 'super_admin' && row.tenantId !== null) {
        throw new BadRequestException(
          'Super admin role requires a VAG (unscoped) user',
        );
      }
      data.role = body.role;
    }

    if (body.status !== undefined) {
      if (!['active', 'suspended', 'invited'].includes(body.status)) {
        throw new BadRequestException('Invalid status');
      }
      data.status = body.status;
    }

    if (body.password !== undefined && body.password.length > 0) {
      if (!isStrongPassword(body.password)) {
        throw new BadRequestException(STRONG_PASSWORD_HINT);
      }
      data.passwordHash = await hashPassword(body.password);
      data.tokenVersion = { increment: 1 };
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No fields to update');
    }

    const updated = await this.prisma.user.update({
      where: { id: row.id },
      data,
      include: {
        tenantRole: { select: { id: true, name: true } },
      },
    });
    this.invalidateUserCaches(row.tenantId);
    if (data.name) {
      await this.prisma.employee.updateMany({
        where: { userId: updated.id, deletedAt: null },
        data: { name: data.name },
      });
    }
    if (
      body.tenantRoleId !== undefined ||
      body.role !== undefined ||
      body.password !== undefined
    ) {
      void invalidateUserAuthSession(this.cache, updated.id);
    }
    if (body.tenantRoleId !== undefined) {
      void this.syncEmployeeServiceStaffFromUserRole(
        updated.id,
        updated.tenantRoleId,
      );
    }
    return { user: this.toUser(updated) };
  }

  async updateUserStatus(
    actor: AuthenticatedUser,
    id: string,
    status: 'active' | 'suspended',
  ): Promise<{ user: User }> {
    return this.updateUser(actor, id, { status });
  }

  async deactivateUser(
    actor: AuthenticatedUser,
    id: string,
  ): Promise<{ user: User }> {
    const row = await this.findManagedUser(actor, id);
    if (row.id === actor.sub) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    const updated = await this.prisma.user.update({
      where: { id: row.id },
      data: {
        status: 'suspended',
        deletedAt: new Date(),
        tokenVersion: { increment: 1 },
      },
    });
    this.invalidateUserCaches(row.tenantId);
    return { user: this.toUser(updated) };
  }

  private async findManagedUser(actor: AuthenticatedUser, id: string) {
    const row = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException('User not found');
    }
    if (actor.role === 'admin') {
      const tenantId = this.tenantDb.requireTenantId();
      if (row.tenantId !== tenantId) {
        const hasClearance = await this.userHasClearanceForTenant(id, tenantId);
        if (!hasClearance) {
          throw new ForbiddenException(
            'Cannot manage users outside your entity',
          );
        }
      }
    }
    return row;
  }

  private async resolveUserAssignment(
    actor: AuthenticatedUser,
    body: {
      email: string;
      name: string;
      role: User['role'];
      tenantId?: string | null;
    },
  ): Promise<{
    email: string;
    name: string;
    role: User['role'];
    targetTenantId: string | null;
  }> {
    if (actor.role !== 'admin' && actor.role !== 'super_admin') {
      throw new ForbiddenException('Only admins can manage users');
    }

    const email = body.email.trim().toLowerCase();
    const name = body.name.trim();
    if (!email || !name) {
      throw new BadRequestException('Email and name are required');
    }
    if (!ROLES.includes(body.role)) {
      throw new BadRequestException('Invalid role');
    }

    const adminInvitable: User['role'][] = ['manager', 'staff', 'viewer'];
    const superInvitable: User['role'][] = [
      'admin',
      'manager',
      'staff',
      'viewer',
      'super_admin',
    ];

    let targetTenantId: string | null;

    if (actor.role === 'super_admin') {
      if (!superInvitable.includes(body.role)) {
        throw new BadRequestException('Invalid role');
      }
      if (body.role === 'super_admin') {
        targetTenantId = null;
      } else if (body.tenantId) {
        targetTenantId = body.tenantId;
      } else {
        targetTenantId = this.tenantDb.resolveTenantId();
      }
    } else {
      if (!adminInvitable.includes(body.role)) {
        throw new ForbiddenException(
          'Admins can only add manager, staff, or viewer',
        );
      }
      targetTenantId = this.tenantDb.requireTenantId();
    }

    if (body.role !== 'super_admin' && !targetTenantId) {
      throw new BadRequestException(
        'Entity is required. Select an entity or open Users from that entity.',
      );
    }
    if (body.role === 'super_admin' && targetTenantId !== null) {
      throw new BadRequestException(
        'Super admin users cannot belong to an entity',
      );
    }

    if (targetTenantId) {
      const tenant = await this.prisma.tenant.findFirst({
        where: { id: targetTenantId, deletedAt: null },
      });
      if (!tenant) {
        throw new BadRequestException('Entity not found');
      }
    }

    return { email, name, role: body.role, targetTenantId };
  }

  /** Keep Employee.isServiceStaff aligned when a user's job role changes. */
  private async syncEmployeeServiceStaffFromUserRole(
    userId: string,
    tenantRoleId: string | null,
  ): Promise<void> {
    let roleIsServiceStaff = false;
    if (tenantRoleId) {
      const role = await this.prisma.tenantRole.findFirst({
        where: { id: tenantRoleId, deletedAt: null },
        select: { isServiceStaff: true },
      });
      roleIsServiceStaff = Boolean(role?.isServiceStaff);
    }

    if (roleIsServiceStaff) {
      await this.prisma.employee.updateMany({
        where: { userId, deletedAt: null },
        data: { isServiceStaff: true },
      });
      return;
    }

    const employees = await this.prisma.employee.findMany({
      where: { userId, deletedAt: null },
      select: {
        id: true,
        isServiceStaff: true,
        department: true,
        designation: { select: { name: true } },
      },
    });
    await Promise.all(
      employees.map(async (emp) => {
        const keep = isServiceStaffEligible({
          roleIsServiceStaff: false,
          designation: emp.designation?.name,
          department: emp.department,
        });
        if (emp.isServiceStaff === keep) return;
        await this.prisma.employee.update({
          where: { id: emp.id },
          data: { isServiceStaff: keep },
        });
      }),
    );
  }

  private async resolveTenantRoleBinding(
    tenantId: string | null,
    tenantRoleId: string | null | undefined,
    fallbackRole: User['role'],
  ): Promise<{
    jwtRole: User['role'];
    tenantRoleId: string | null;
  }> {
    if (tenantRoleId === undefined) {
      return { jwtRole: fallbackRole, tenantRoleId: null };
    }
    if (tenantRoleId === null || tenantRoleId === '') {
      return { jwtRole: fallbackRole, tenantRoleId: null };
    }
    if (!tenantId) {
      throw new BadRequestException(
        'Tenant job roles can only be assigned to tenant-scoped users',
      );
    }

    let role = await this.prisma.tenantRole.findFirst({
      where: { id: tenantRoleId, tenantId, deletedAt: null },
    });

    // Shared HQ6 catalog: each entity has its own row ids for the same role
    // name. VAG edit may submit a peer-tenant role id — map by name.
    if (!role) {
      const any = await this.prisma.tenantRole.findFirst({
        where: { id: tenantRoleId, deletedAt: null },
      });
      if (any) {
        role = await this.prisma.tenantRole.findFirst({
          where: {
            tenantId,
            deletedAt: null,
            name: { equals: any.name, mode: 'insensitive' },
          },
        });
      }
    }

    if (!role) {
      throw new BadRequestException('Invalid tenant role');
    }
    const jwtRole = mapTenantRoleToJwtRole(role);
    if (fallbackRole === 'super_admin') {
      return { jwtRole: 'super_admin', tenantRoleId: role.id };
    }
    return { jwtRole, tenantRoleId: role.id };
  }

  private toUser(row: {
    id: string;
    email: string;
    username?: string | null;
    name: string;
    role: User['role'];
    status: User['status'];
    tenantId: string | null;
    tenantRoleId?: string | null;
    tenantRole?: { id: string; name: string } | null;
    createdAt: Date;
    lastLoginAt: Date | null;
  }): User {
    return {
      id: row.id,
      email: row.email,
      username: row.username ?? null,
      name: row.name,
      role: row.role,
      status: row.status,
      tenantId: row.tenantId,
      tenantRoleId: row.tenantRoleId ?? row.tenantRole?.id ?? null,
      tenantRoleName: row.tenantRole?.name ?? null,
      createdAt: toIso(row.createdAt),
      lastLoginAt: row.lastLoginAt ? toIso(row.lastLoginAt) : null,
    };
  }

  /** Normalize + ensure username uniqueness (case-insensitive). */
  private async resolveUniqueUsername(
    raw: string | null | undefined,
    email: string,
    excludeUserId?: string,
  ): Promise<string> {
    const fromEmail = email.trim().split('@')[0]?.toLowerCase() ?? '';
    let candidate = (raw?.trim() || fromEmail).toLowerCase();
    candidate = candidate.replace(/[^a-z0-9._-]/g, '');
    if (!candidate) {
      throw new BadRequestException('Username is required');
    }
    if (candidate.includes('@')) {
      throw new BadRequestException('Username cannot contain @');
    }

    const clash = await this.prisma.user.findFirst({
      where: {
        username: { equals: candidate, mode: 'insensitive' },
        deletedAt: null,
        ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}),
      },
    });
    if (clash) {
      throw new ConflictException('A user with this username already exists');
    }
    return candidate;
  }

  private daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }
}
