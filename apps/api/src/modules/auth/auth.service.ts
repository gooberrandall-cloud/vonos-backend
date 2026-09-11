import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthTokenType, Role, User } from '@prisma/client';
import type {
  ForgotPasswordResponse,
  InviteDetails,
  LoginSuccessResponse,
  LoginUser,
  SessionDebugAccessStatus,
  SessionDebugRefreshStatus,
  SessionDebugResponse,
  TwoFactorChallengeResponse,
  TwoFactorSetupResponse,
} from '@vonos/types';
import { isFullAccessTenantRole } from '@vonos/types';
import {
  FINANCE_ROLE_DEFAULT_PERMISSIONS,
  HR_ROLE_DEFAULT_PERMISSIONS,
  isFinanceAuthorizedRoleName,
  isHrRoleName,
} from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { invalidateTenantDashboardCache } from '../../common/cache/cacheInvalidation';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../../common/utils/auth-token';
import {
  hashPassword,
  isStrongPassword,
  needsPasswordRehash,
  STRONG_PASSWORD_HINT,
  verifyPassword,
} from '../../common/utils/password';
import {
  resolvePrimaryWebOrigin,
  resolveWebOrigins,
} from '../../common/utils/webOrigin';
import {
  buildOtpauthUrl,
  generateTotpSecret,
  verifyTotpCode,
} from '../../common/utils/totp';
import {
  normalizeWorkLocationToTenantCode,
  uniqueTenantCodesFromWorkLocations,
} from '../../common/utils/workLocationTenantCodes';
import {
  ACCESS_TOKEN_TTL,
  PASSWORD_RESET_HOURS,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_DAYS,
  ROLES_REQUIRING_2FA,
} from './auth.constants';
import { AuthMailService } from './auth-mail.service';

const REFRESH_REUSE_GRACE_MS = 30_000;

type SessionUser = User & {
  tenantRole?: {
    id: string;
    name: string;
    permissions: string[];
    locked: boolean;
  } | null;
};

interface AccessTokenPayload {
  sub: string;
  tenantId: string | null;
  role: Role;
  tokenVersion: number;
  type: 'access';
}

interface ChallengeTokenPayload {
  sub: string;
  tokenVersion: number;
  type: '2fa_challenge';
}

interface LoginDto {
  /** Email address or username. */
  email: string;
  password: string;
}

/** Avoid a Neon RTT on every authenticated request; revocation lags ≤ TTL. */
const ACCESS_TOKEN_VERSION_CACHE_TTL_S = 60;

export interface SessionResult extends LoginSuccessResponse {
  /** Present only when the refresh cookie should be replaced. */
  refreshTokenRaw?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly mail: AuthMailService,
    private readonly cache: CacheService,
  ) {}

  async login(
    body: LoginDto,
  ): Promise<TwoFactorChallengeResponse | SessionResult> {
    const user = await this.findActiveUserByLogin(body.email);
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Rehash off the critical path — verify already succeeded with the old hash.
    void this.upgradePasswordHashIfNeeded(
      user.id,
      body.password,
      user.passwordHash,
    );

    if (
      ROLES_REQUIRING_2FA.has(user.role) &&
      user.totpEnabled &&
      user.totpSecret
    ) {
      return {
        requiresTwoFactor: true,
        challengeToken: this.signChallengeToken(user),
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      };
    }

    return this.issueSession(user);
  }

  async verifyTwoFactor(
    challengeToken: string,
    code: string,
  ): Promise<SessionResult> {
    const payload = this.verifyChallengeToken(challengeToken);
    const user = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        deletedAt: null,
        status: 'active',
        totpEnabled: true,
      },
    });

    if (!user?.totpSecret || user.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException('Invalid or expired challenge');
    }

    if (!(await verifyTotpCode(user.totpSecret, code))) {
      throw new UnauthorizedException('Invalid authentication code');
    }

    return this.issueSession(user);
  }

  /**
   * Mint a new access JWT from a valid refresh cookie.
   * Does NOT rotate the refresh token — rotating every soft-refresh broke
   * cross-origin sessions when Set-Cookie failed to stick (Chrome 3P cookies).
   */
  async refreshSession(
    refreshTokenRaw: string,
    preferredTenantId?: string | null,
  ): Promise<SessionResult> {
    const tokenHash = hashOpaqueToken(refreshTokenRaw);
    const stored = await this.prisma.authToken.findFirst({
      where: {
        tokenHash,
        type: 'refresh',
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    if (
      !stored?.user ||
      stored.user.deletedAt ||
      stored.user.status !== 'active'
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Older builds marked refresh tokens used on every soft-refresh. Treat
    // usedAt as informational only here so those cookies recover. Logout /
    // password-reset still mark tokens used; clients clear the cookie too.
    if (stored.usedAt) {
      await this.prisma.authToken.update({
        where: { id: stored.id },
        data: { usedAt: null },
      });
    }

    const activeTenantId = await this.resolveActiveTenantIdForSession(
      stored.user,
      preferredTenantId,
    );
    const allowedTenantCodes = await this.resolveAllowedTenantCodes(
      stored.user,
    );
    const loginUser = await this.buildLoginUser(stored.user, {
      activeTenantId,
      allowedTenantCodes,
    });

    return {
      accessToken: this.signAccessToken({
        id: stored.user.id,
        tenantId: loginUser.tenantId,
        role: stored.user.role,
        tokenVersion: stored.user.tokenVersion,
      }),
      user: loginUser,
      // Same cookie value — controller slides maxAge without rotating.
      refreshTokenRaw,
    };
  }

  /** Fresh LoginUser (permissions) for a valid access token — no cookie touch. */
  async getSessionProfile(
    userId: string,
    preferredTenantId?: string | null,
  ): Promise<LoginUser> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null, status: 'active' },
      include: {
        tenantRole: {
          select: {
            id: true,
            name: true,
            permissions: true,
            locked: true,
          },
        },
      },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const activeTenantId = await this.resolveActiveTenantIdForSession(
      user,
      preferredTenantId,
    );
    const allowedTenantCodes = await this.resolveAllowedTenantCodes(user);
    return this.buildLoginUser(user, { activeTenantId, allowedTenantCodes });
  }

  /**
   * Re-issue access token scoped to a cleared work location (entity).
   * Home `User.tenantId` is unchanged — only the JWT / session tenant switches.
   */
  async switchWorkingTenant(
    userId: string,
    tenantCode: string,
  ): Promise<LoginSuccessResponse> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null, status: 'active' },
      include: {
        tenantRole: {
          select: {
            id: true,
            name: true,
            permissions: true,
            locked: true,
          },
        },
      },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.role === 'super_admin') {
      throw new BadRequestException(
        'Super admins use the entity switcher, not work-location switch',
      );
    }

    const allowedCodes = await this.resolveAllowedTenantCodes(user);
    const mapped = normalizeWorkLocationToTenantCode(tenantCode);
    if (!mapped || !allowedCodes.includes(mapped)) {
      throw new ForbiddenException(
        'You do not have clearance for that location',
      );
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { code: mapped, deletedAt: null },
      select: { id: true, code: true },
    });
    if (!tenant) throw new NotFoundException('Location not found');

    const loginUser = await this.buildLoginUser(user, {
      activeTenantId: tenant.id,
      allowedTenantCodes: allowedCodes,
    });

    return {
      accessToken: this.signAccessToken({
        id: user.id,
        tenantId: tenant.id,
        role: user.role,
        tokenVersion: user.tokenVersion,
      }),
      user: loginUser,
    };
  }

  async logout(refreshTokenRaw?: string): Promise<void> {
    if (!refreshTokenRaw) return;
    const tokenHash = hashOpaqueToken(refreshTokenRaw);
    await this.prisma.authToken.updateMany({
      where: {
        tokenHash,
        type: 'refresh',
        usedAt: null,
      },
      data: { usedAt: new Date() },
    });
  }

  async forgotPassword(email: string): Promise<ForgotPasswordResponse> {
    const normalized = email.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        email: { equals: normalized, mode: 'insensitive' },
        deletedAt: null,
        status: { in: ['active', 'invited'] },
      },
    });

    let devResetUrl: string | undefined;
    if (user) {
      const { raw, hash } = generateOpaqueToken();
      await this.invalidateTokens(user.id, 'password_reset');
      await this.prisma.authToken.create({
        data: {
          userId: user.id,
          type: 'password_reset',
          tokenHash: hash,
          expiresAt: this.hoursFromNow(PASSWORD_RESET_HOURS),
        },
      });

      const webOrigin = resolvePrimaryWebOrigin();
      const resetUrl = `${webOrigin}/reset-password/${raw}`;
      this.mail.sendPasswordReset(user.email, resetUrl);

      if (process.env.NODE_ENV !== 'production') {
        devResetUrl = resetUrl;
      }
    }

    return { success: true, devResetUrl };
  }

  async validateResetToken(rawToken: string): Promise<{ email: string }> {
    const token = await this.findValidToken(rawToken, 'password_reset');
    return { email: token.user.email };
  }

  async resetPassword(rawToken: string, password: string): Promise<void> {
    if (!isStrongPassword(password)) {
      throw new BadRequestException(STRONG_PASSWORD_HINT);
    }

    const token = await this.findValidToken(rawToken, 'password_reset');
    const passwordHash = await hashPassword(password);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: token.userId },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 },
          status: 'active',
        },
      }),
      this.prisma.authToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.authToken.updateMany({
        where: {
          userId: token.userId,
          type: 'refresh',
          usedAt: null,
        },
        data: { usedAt: new Date() },
      }),
    ]);
  }

  async getInvite(rawToken: string): Promise<InviteDetails> {
    const token = await this.findValidToken(rawToken, 'invite');
    const user = token.user;
    const tenant = user.tenantId
      ? await this.prisma.tenant.findUnique({ where: { id: user.tenantId } })
      : null;

    return {
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
      tenantName: tenant?.name ?? null,
    };
  }

  async acceptInvite(
    rawToken: string,
    password: string,
    name?: string,
  ): Promise<SessionResult> {
    if (!isStrongPassword(password)) {
      throw new BadRequestException(STRONG_PASSWORD_HINT);
    }

    const token = await this.findValidToken(rawToken, 'invite');
    const passwordHash = await hashPassword(password);

    const user = await this.prisma.$transaction(async (tx) => {
      await tx.authToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      });
      return tx.user.update({
        where: { id: token.userId },
        data: {
          passwordHash,
          name: name?.trim() || token.user.name,
          status: 'active',
          tokenVersion: { increment: 1 },
        },
      });
    });

    if (user.tenantId) {
      void invalidateTenantDashboardCache(this.cache, user.tenantId);
    }

    return this.issueSession(user);
  }

  async setupTwoFactor(userId: string): Promise<TwoFactorSetupResponse> {
    const user = await this.requireAdminUser(userId);
    const secret = generateTotpSecret();

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecret: secret,
        totpEnabled: false,
      },
    });

    return {
      secret,
      otpauthUrl: buildOtpauthUrl(user.email, secret),
    };
  }

  async confirmTwoFactor(userId: string, code: string): Promise<void> {
    const user = await this.requireAdminUser(userId);
    if (!user.totpSecret) {
      throw new BadRequestException('Start 2FA setup first');
    }
    if (!(await verifyTotpCode(user.totpSecret, code))) {
      throw new BadRequestException('Invalid authentication code');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: true },
    });
  }

  async disableTwoFactor(userId: string, code: string): Promise<void> {
    const user = await this.requireAdminUser(userId);
    if (!user.totpEnabled || !user.totpSecret) {
      throw new BadRequestException('2FA is not enabled');
    }
    if (!(await verifyTotpCode(user.totpSecret, code))) {
      throw new BadRequestException('Invalid authentication code');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        totpEnabled: false,
        totpSecret: null,
        tokenVersion: { increment: 1 },
      },
    });

    await this.invalidateTokens(user.id, 'refresh');
  }

  async validateAccessToken(token: string): Promise<AccessTokenPayload> {
    const payload = this.jwtService.verify<AccessTokenPayload>(token);
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }

    const versionKey = `auth:tv:${payload.sub}:${payload.tokenVersion}`;
    const cachedOk = await this.cache.get<boolean>(versionKey);
    if (cachedOk) {
      return payload;
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        deletedAt: null,
        status: 'active',
      },
      select: { tokenVersion: true },
    });

    if (!user || user.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException('Token revoked');
    }

    await this.cache.set(versionKey, true, ACCESS_TOKEN_VERSION_CACHE_TTL_S);
    return payload;
  }

  /**
   * Resolve HQ6 permission-matrix keys + role name for the authenticated
   * user's assigned TenantRole. Used by backend permission-based guards.
   *
   * Cached per (userId, tokenVersion) to avoid querying on every request.
   */
  async resolveTenantRoleContext(
    userId: string,
    tokenVersion: number,
  ): Promise<{ permissions: string[]; name: string | null }> {
    const cacheKey = `auth:tenantRoleCtx:${userId}:${tokenVersion}`;
    const cached = await this.cache.get<{
      permissions: string[];
      name: string | null;
    } | null>(cacheKey);
    if (cached) return cached;

    const tenantRole = await this.prisma.tenantRole.findFirst({
      where: {
        users: { some: { id: userId } },
        deletedAt: null,
      },
      select: { id: true, name: true, permissions: true, locked: true },
    });

    // Fallback: if tenantRole relation isn't indexed as expected, query via tenantRoleId.
    const user = tenantRole
      ? null
      : await this.prisma.user.findFirst({
          where: { id: userId, deletedAt: null, status: 'active' },
          select: {
            tenantRoleId: true,
            tenantRole: {
              select: { id: true, name: true, permissions: true, locked: true },
            },
          },
        });

    const effectiveRole = tenantRole ?? user?.tenantRole ?? null;

    let permissions: string[] = [];
    if (!effectiveRole) {
      permissions = [];
    } else if (isFullAccessTenantRole(effectiveRole)) {
      permissions = ['*'];
    } else {
      permissions = [...effectiveRole.permissions];
      if (isHrRoleName(effectiveRole.name) && permissions.length === 0) {
        permissions = [...HR_ROLE_DEFAULT_PERMISSIONS];
      }
      if (isFinanceAuthorizedRoleName(effectiveRole.name)) {
        permissions = [
          ...new Set([...permissions, ...FINANCE_ROLE_DEFAULT_PERMISSIONS]),
        ];
      }
    }

    const result = {
      permissions,
      name: effectiveRole?.name ?? null,
    };
    await this.cache.set(cacheKey, result, ACCESS_TOKEN_VERSION_CACHE_TTL_S);
    return result;
  }

  /** @deprecated Prefer resolveTenantRoleContext */
  async resolveTenantRolePermissions(
    userId: string,
    tokenVersion: number,
  ): Promise<string[]> {
    const ctx = await this.resolveTenantRoleContext(userId, tokenVersion);
    return ctx.permissions;
  }

  private async issueSession(
    user: SessionUser,
    options?: { activeTenantId?: string | null },
  ): Promise<SessionResult> {
    const { raw, hash } = generateOpaqueToken();
    // One Neon write on the critical path. lastLoginAt is best-effort.
    await this.prisma.authToken.create({
      data: {
        userId: user.id,
        type: 'refresh',
        tokenHash: hash,
        expiresAt: this.daysFromNow(REFRESH_TOKEN_DAYS),
      },
    });
    void this.prisma.user
      .update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      })
      .catch(() => undefined);

    const allowedTenantCodes = await this.resolveAllowedTenantCodes(user);
    const activeTenantId =
      options?.activeTenantId !== undefined
        ? options.activeTenantId
        : user.tenantId;
    const loginUser = await this.buildLoginUser(user, {
      activeTenantId,
      allowedTenantCodes,
    });

    return {
      accessToken: this.signAccessToken({
        id: user.id,
        tenantId: loginUser.tenantId,
        role: user.role,
        tokenVersion: user.tokenVersion,
      }),
      refreshTokenRaw: raw,
      user: loginUser,
    };
  }

  private async buildLoginUser(
    user: SessionUser,
    options: {
      activeTenantId?: string | null;
      allowedTenantCodes?: string[];
    },
  ): Promise<LoginUser> {
    let tenantRole = user.tenantRole ?? null;
    if (!tenantRole && user.tenantRoleId) {
      tenantRole = await this.prisma.tenantRole.findFirst({
        where: { id: user.tenantRoleId, deletedAt: null },
        select: {
          id: true,
          name: true,
          permissions: true,
          locked: true,
        },
      });
    }

    const allowedTenantCodes =
      options.allowedTenantCodes ??
      (await this.resolveAllowedTenantCodes(user));

    let permissions: string[] = [];
    if (tenantRole) {
      if (isFullAccessTenantRole(tenantRole)) {
        permissions = ['*'];
      } else {
        permissions = [...tenantRole.permissions];
        if (isHrRoleName(tenantRole.name) && permissions.length === 0) {
          permissions = [...HR_ROLE_DEFAULT_PERMISSIONS];
        }
        // Session-time merge so Accountant sees Finance even before a Roles
        // catalog backfill has rewritten the DB row. Other roles need the
        // Financial dashboard checkbox on their TenantRole matrix.
        if (isFinanceAuthorizedRoleName(tenantRole.name)) {
          permissions = [
            ...new Set([
              ...permissions,
              ...FINANCE_ROLE_DEFAULT_PERMISSIONS,
            ]),
          ];
        }
      }
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId:
        options.activeTenantId !== undefined
          ? options.activeTenantId
          : user.tenantId,
      tenantRoleId: tenantRole?.id ?? user.tenantRoleId ?? null,
      tenantRoleName: tenantRole?.name ?? null,
      tenantRolePermissions: permissions,
      tenantRoleLocked: tenantRole?.locked ?? false,
      allowedTenantCodes:
        user.role === 'super_admin' ? [] : allowedTenantCodes,
    };
  }

  /** Cached per request burst — work-location clearances change rarely. */
  async resolveAllowedTenantCodesForSession(
    user: Pick<User, 'id' | 'tenantId' | 'role'>,
  ): Promise<string[]> {
    if (user.role === 'super_admin') return [];

    const cacheKey = `auth:allowedTenantCodes:${user.id}`;
    const cached = await this.cache.get<string[]>(cacheKey);
    if (cached) return cached;

    const codes = await this.resolveAllowedTenantCodes(user);
    await this.cache.set(cacheKey, codes, 300);
    return codes;
  }

  /** Entity codes from linked employee work locations + home tenant. */
  private async resolveAllowedTenantCodes(
    user: Pick<User, 'id' | 'tenantId' | 'role'>,
  ): Promise<string[]> {
    if (user.role === 'super_admin') return [];

    const [employees, homeTenant] = await Promise.all([
      this.prisma.employee.findMany({
        where: { userId: user.id, deletedAt: null },
        select: { locationCodes: true, locationCode: true },
      }),
      user.tenantId
        ? this.prisma.tenant.findFirst({
            where: { id: user.tenantId, deletedAt: null },
            select: { code: true },
          })
        : Promise.resolve(null),
    ]);

    // Union every employee row — a stale copy on one entity must not hide
    // clearances saved on the home-tenant payroll link.
    const workLocations = employees.flatMap((employee) => [
      ...(employee.locationCodes ?? []),
      ...(employee.locationCode ? [employee.locationCode] : []),
    ]);

    return uniqueTenantCodesFromWorkLocations(
      workLocations,
      homeTenant?.code ?? null,
    );
  }

  private async resolveActiveTenantIdForSession(
    user: Pick<User, 'id' | 'tenantId' | 'role'>,
    preferredTenantId?: string | null,
  ): Promise<string | null> {
    if (user.role === 'super_admin') return user.tenantId;
    if (!preferredTenantId || preferredTenantId === user.tenantId) {
      return user.tenantId;
    }

    const preferred = await this.prisma.tenant.findFirst({
      where: { id: preferredTenantId, deletedAt: null },
      select: { id: true, code: true },
    });
    if (!preferred) return user.tenantId;

    const allowed = await this.resolveAllowedTenantCodes(user);
    if (!allowed.includes(preferred.code)) return user.tenantId;
    return preferred.id;
  }

  private signAccessToken(
    user: Pick<User, 'id' | 'tenantId' | 'role' | 'tokenVersion'>,
  ): string {
    const payload: AccessTokenPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      tokenVersion: user.tokenVersion,
      type: 'access',
    };
    return this.jwtService.sign(payload);
  }

  private signChallengeToken(user: Pick<User, 'id' | 'tokenVersion'>): string {
    const payload: ChallengeTokenPayload = {
      sub: user.id,
      tokenVersion: user.tokenVersion,
      type: '2fa_challenge',
    };
    return this.jwtService.sign(payload, { expiresIn: '5m' });
  }

  private verifyChallengeToken(token: string): ChallengeTokenPayload {
    const payload = this.jwtService.verify<ChallengeTokenPayload>(token);
    if (payload.type !== '2fa_challenge') {
      throw new UnauthorizedException('Invalid challenge token');
    }
    return payload;
  }

  private async findActiveUserByLogin(identifier: string) {
    const normalized = identifier.trim().toLowerCase();
    if (!normalized) return null;

    if (normalized.includes('@')) {
      return this.prisma.user.findFirst({
        where: {
          email: { equals: normalized, mode: 'insensitive' },
          deletedAt: null,
          status: 'active',
        },
      });
    }

    const byUsername = await this.prisma.user.findFirst({
      where: {
        username: { equals: normalized, mode: 'insensitive' },
        deletedAt: null,
        status: 'active',
      },
    });
    if (byUsername) return byUsername;

    // Legacy / seed rows often have username NULL while the UI showed the
    // email local-part as "username". Allow that handle when unambiguous.
    const byEmailLocal = await this.prisma.user.findMany({
      where: {
        username: null,
        deletedAt: null,
        status: 'active',
        email: { startsWith: `${normalized}@`, mode: 'insensitive' },
      },
      take: 2,
    });
    return byEmailLocal.length === 1 ? byEmailLocal[0]! : null;
  }

  private async findActiveUserByEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    if (!user || user.deletedAt || user.status !== 'active') return null;
    return user;
  }

  private async upgradePasswordHashIfNeeded(
    userId: string,
    password: string,
    passwordHash: string,
  ): Promise<void> {
    if (!needsPasswordRehash(passwordHash)) return;
    try {
      const nextHash = await hashPassword(password);
      await this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash: nextHash },
      });
    } catch {
      // Best-effort; next login will retry.
    }
  }

  private async findValidToken(rawToken: string, type: AuthTokenType) {
    const tokenHash = hashOpaqueToken(rawToken);
    const token = await this.prisma.authToken.findFirst({
      where: {
        tokenHash,
        type,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });

    if (!token?.user || token.user.deletedAt) {
      throw new NotFoundException('Token is invalid or expired');
    }

    return token;
  }

  private async invalidateTokens(
    userId: string,
    type: AuthTokenType,
  ): Promise<void> {
    await this.prisma.authToken.updateMany({
      where: {
        userId,
        type,
        usedAt: null,
      },
      data: { usedAt: new Date() },
    });
    // Drop cached access-token version checks for this user.
    await this.cache.invalidatePrefix(`auth:tv:${userId}:`);
  }

  /**
   * Read-only session probe for early-logout debugging.
   * Does not rotate tokens or mutate auth state.
   */
  async inspectSessionDebug(input: {
    refreshTokenRaw?: string;
    accessTokenRaw?: string;
    requestOrigin?: string | null;
    cookieSameSite: 'none' | 'lax';
    cookieSecure: boolean;
  }): Promise<SessionDebugResponse> {
    const now = Date.now();
    const webOrigins = resolveWebOrigins();
    const requestOrigin = input.requestOrigin?.trim()
      ? input.requestOrigin.trim().replace(/\/$/, '')
      : null;
    const requestOriginAllowed = requestOrigin
      ? webOrigins.includes(requestOrigin)
      : null;

    const refresh = await this.inspectRefreshForDebug(input.refreshTokenRaw);
    const access = await this.inspectAccessForDebug(input.accessTokenRaw);

    const config: SessionDebugResponse['config'] = {
      nodeEnv: process.env.NODE_ENV ?? null,
      jwtAccessExpires: process.env.JWT_ACCESS_EXPIRES ?? ACCESS_TOKEN_TTL,
      jwtSecretConfigured: Boolean(
        process.env.JWT_SECRET &&
          process.env.JWT_SECRET !== 'dev-secret-change-me' &&
          process.env.JWT_SECRET !== 'change-me-in-production',
      ),
      cookieSameSite: input.cookieSameSite,
      cookieSecure: input.cookieSecure,
      refreshTokenDays: REFRESH_TOKEN_DAYS,
      webOrigins,
      requestOrigin,
      requestOriginAllowed,
    };

    return {
      ok: true,
      at: new Date(now).toISOString(),
      refresh: {
        cookiePresent: Boolean(input.refreshTokenRaw),
        cookieName: REFRESH_COOKIE_NAME,
        ...refresh,
      },
      access: {
        headerPresent: Boolean(input.accessTokenRaw),
        ...access,
      },
      config,
      verdict: this.sessionDebugVerdict({
        cookiePresent: Boolean(input.refreshTokenRaw),
        refreshStatus: refresh.status,
        accessStatus: access.status,
        accessExpiresInSec: access.expiresInSec,
        requestOriginAllowed,
        cookieSameSite: input.cookieSameSite,
      }),
    };
  }

  private async inspectRefreshForDebug(refreshTokenRaw?: string): Promise<{
    status: SessionDebugRefreshStatus;
    expiresInSec: number | null;
    usedAtAgeSec: number | null;
    userId: string | null;
  }> {
    if (!refreshTokenRaw) {
      return {
        status: 'missing',
        expiresInSec: null,
        usedAtAgeSec: null,
        userId: null,
      };
    }

    const tokenHash = hashOpaqueToken(refreshTokenRaw);
    const stored = await this.prisma.authToken.findFirst({
      where: { tokenHash, type: 'refresh' },
      include: {
        user: { select: { id: true, status: true, deletedAt: true } },
      },
    });

    if (!stored) {
      return {
        status: 'not_found',
        expiresInSec: null,
        usedAtAgeSec: null,
        userId: null,
      };
    }

    const expiresInSec = Math.floor(
      (stored.expiresAt.getTime() - Date.now()) / 1000,
    );
    const usedAtAgeSec = stored.usedAt
      ? Math.floor((Date.now() - stored.usedAt.getTime()) / 1000)
      : null;
    const userId = stored.userId;

    if (
      !stored.user ||
      stored.user.deletedAt ||
      stored.user.status !== 'active'
    ) {
      return {
        status: 'user_inactive',
        expiresInSec,
        usedAtAgeSec,
        userId,
      };
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      return {
        status: 'expired',
        expiresInSec,
        usedAtAgeSec,
        userId,
      };
    }

    if (stored.usedAt) {
      const ageMs = Date.now() - stored.usedAt.getTime();
      return {
        status:
          ageMs <= REFRESH_REUSE_GRACE_MS ? 'used_within_grace' : 'used',
        expiresInSec,
        usedAtAgeSec,
        userId,
      };
    }

    return {
      status: 'valid',
      expiresInSec,
      usedAtAgeSec,
      userId,
    };
  }

  private async inspectAccessForDebug(accessTokenRaw?: string): Promise<{
    status: SessionDebugAccessStatus;
    expiresInSec: number | null;
    userId: string | null;
    role: string | null;
    tokenVersion: number | null;
  }> {
    if (!accessTokenRaw) {
      return {
        status: 'missing',
        expiresInSec: null,
        userId: null,
        role: null,
        tokenVersion: null,
      };
    }

    let payload: AccessTokenPayload;
    try {
      payload = this.jwtService.verify<AccessTokenPayload>(accessTokenRaw);
    } catch (error) {
      const name =
        error && typeof error === 'object' && 'name' in error
          ? String((error as { name?: string }).name)
          : '';
      return {
        status: name === 'TokenExpiredError' ? 'expired' : 'invalid_signature',
        expiresInSec: null,
        userId: null,
        role: null,
        tokenVersion: null,
      };
    }

    if (payload.type && payload.type !== 'access') {
      return {
        status: 'wrong_type',
        expiresInSec: null,
        userId: payload.sub ?? null,
        role: payload.role ?? null,
        tokenVersion: payload.tokenVersion ?? null,
      };
    }

    const decoded = this.jwtService.decode(accessTokenRaw) as {
      exp?: number;
    } | null;
    const expiresInSec =
      decoded?.exp != null
        ? Math.floor(decoded.exp - Date.now() / 1000)
        : null;

    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub },
      select: { status: true, deletedAt: true, tokenVersion: true },
    });

    if (!user || user.deletedAt || user.status !== 'active') {
      return {
        status: 'user_inactive',
        expiresInSec,
        userId: payload.sub,
        role: payload.role,
        tokenVersion: payload.tokenVersion,
      };
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      return {
        status: 'version_mismatch',
        expiresInSec,
        userId: payload.sub,
        role: payload.role,
        tokenVersion: payload.tokenVersion,
      };
    }

    return {
      status: 'valid',
      expiresInSec,
      userId: payload.sub,
      role: payload.role,
      tokenVersion: payload.tokenVersion,
    };
  }

  private sessionDebugVerdict(input: {
    cookiePresent: boolean;
    refreshStatus: SessionDebugRefreshStatus;
    accessStatus: SessionDebugAccessStatus;
    accessExpiresInSec: number | null;
    requestOriginAllowed: boolean | null;
    cookieSameSite: 'none' | 'lax';
  }): string {
    if (input.requestOriginAllowed === false) {
      return 'Request Origin is not in WEB_ORIGIN — browser will block credentialed refresh (CORS).';
    }
    if (!input.cookiePresent) {
      return input.cookieSameSite === 'lax'
        ? 'No refresh cookie received. Cross-origin apps need COOKIE_SAMESITE=none (Secure).'
        : 'No refresh cookie received. User will be logged out when the access token expires.';
    }
    if (
      input.refreshStatus === 'used' ||
      input.refreshStatus === 'expired' ||
      input.refreshStatus === 'not_found' ||
      input.refreshStatus === 'user_inactive'
    ) {
      return `Refresh cookie is dead (${input.refreshStatus}). Next access expiry will force login.`;
    }
    if (
      input.accessStatus === 'invalid_signature' ||
      input.accessStatus === 'version_mismatch'
    ) {
      return `Access token rejected (${input.accessStatus}). If JWT_SECRET changed, refresh should recover — check refresh status.`;
    }
    if (
      input.accessStatus === 'expired' ||
      input.accessStatus === 'missing'
    ) {
      return input.refreshStatus === 'valid' ||
        input.refreshStatus === 'used_within_grace'
        ? 'Access expired/missing but refresh looks OK — soft refresh should keep the session.'
        : 'Access expired/missing and refresh is not usable — user is effectively logged out.';
    }
    if (input.accessStatus === 'valid') {
      const mins =
        input.accessExpiresInSec != null
          ? Math.max(0, Math.round(input.accessExpiresInSec / 60))
          : null;
      return mins != null
        ? `Session healthy. Access token ~${mins}m left; refresh cookie present.`
        : 'Session healthy. Access + refresh look valid.';
    }
    return 'Inspect refresh/access statuses above.';
  }

  private async requireAdminUser(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
        status: 'active',
      },
    });

    if (!user || !ROLES_REQUIRING_2FA.has(user.role)) {
      throw new UnauthorizedException('Admin access required');
    }

    return user;
  }

  private hoursFromNow(hours: number): Date {
    return new Date(Date.now() + hours * 60 * 60 * 1000);
  }

  private daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }
}
