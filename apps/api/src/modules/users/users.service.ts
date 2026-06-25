import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { InviteUserResponse, User } from '@vonos/types';
import { ROLES } from '@vonos/types';
import type { AuthenticatedUser } from '../../common/decorators/roles.decorator';
import { generateOpaqueToken } from '../../common/utils/auth-token';
import { devPasswordHash, hashPassword } from '../../common/utils/password';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toIso } from '../../common/utils/serializers';
import { AuthMailService } from '../auth/auth-mail.service';
import { INVITE_DAYS } from '../auth/auth.constants';

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
  ) {}

  async listForTenant(): Promise<User[]> {
    const tenantId = this.tenantDb.requireTenantId();

    const legacyLinks = await this.prisma.migrationLegacyId.findMany({
      where: { tenantId, entityType: 'user' },
      select: { newId: true },
    });
    const legacyUserIds = legacyLinks.map((link) => link.newId);

    const rows = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        OR: [
          { tenantId },
          ...(legacyUserIds.length > 0 ? [{ id: { in: legacyUserIds } }] : []),
        ],
      },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });

    return rows.map((row) => this.toUser(row));
  }

  async listAllTenants(requestRole: string): Promise<UserListRow[]> {
    if (requestRole !== 'super_admin') {
      throw new ForbiddenException('Super admin access required');
    }

    const rows = await this.prisma.user.findMany({
      where: { deletedAt: null },
      include: { tenant: { select: { code: true, name: true } } },
      orderBy: [{ tenantId: 'asc' }, { name: 'asc' }],
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
      tenantId?: string | null;
    },
  ): Promise<InviteUserResponse> {
    const assignment = await this.resolveUserAssignment(actor, body);

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
        name: assignment.name,
        role: assignment.role,
        status: 'invited',
        tenantId: assignment.targetTenantId,
        passwordHash: devPasswordHash('invite-placeholder-not-for-login'),
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

    const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
    const inviteUrl = `${webOrigin}/invite/${raw}`;
    this.mail.sendInvite(assignment.email, inviteUrl);

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
      tenantId?: string | null;
    },
  ): Promise<{ user: User }> {
    const assignment = await this.resolveUserAssignment(actor, body);

    if (!body.password || body.password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
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

    const passwordHash = await hashPassword(body.password);
    const user = await this.prisma.user.create({
      data: {
        email: assignment.email,
        name: assignment.name,
        role: assignment.role,
        status: 'active',
        tenantId: assignment.targetTenantId,
        passwordHash,
      },
    });

    return { user: this.toUser(user) };
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

  private toUser(row: {
    id: string;
    email: string;
    name: string;
    role: User['role'];
    status: User['status'];
    tenantId: string | null;
    createdAt: Date;
    lastLoginAt: Date | null;
  }): User {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.status,
      tenantId: row.tenantId,
      createdAt: toIso(row.createdAt),
      lastLoginAt: row.lastLoginAt ? toIso(row.lastLoginAt) : null,
    };
  }

  private daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }
}
