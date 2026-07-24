import {
  BadRequestException,
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
  TwoFactorChallengeResponse,
  TwoFactorSetupResponse,
} from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../../common/utils/auth-token';
import {
  hashPassword,
  isDevPasswordHash,
  verifyPassword,
} from '../../common/utils/password';
import { resolvePrimaryWebOrigin } from '../../common/utils/webOrigin';
import {
  buildOtpauthUrl,
  generateTotpSecret,
  verifyTotpCode,
} from '../../common/utils/totp';
import {
  PASSWORD_RESET_HOURS,
  REFRESH_TOKEN_DAYS,
  ROLES_REQUIRING_2FA,
} from './auth.constants';
import { AuthMailService } from './auth-mail.service';

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
  email: string;
  password: string;
}

/** Avoid a Neon RTT on every authenticated request; revocation lags ≤ TTL. */
const ACCESS_TOKEN_VERSION_CACHE_TTL_S = 60;

export interface SessionResult extends LoginSuccessResponse {
  refreshTokenRaw: string;
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
    const user = await this.findActiveUserByEmail(body.email);
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.upgradePasswordHashIfNeeded(
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

  async refreshSession(refreshTokenRaw: string): Promise<SessionResult> {
    const tokenHash = hashOpaqueToken(refreshTokenRaw);
    const stored = await this.prisma.authToken.findFirst({
      where: {
        tokenHash,
        type: 'refresh',
        usedAt: null,
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

    await this.prisma.authToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    });

    return this.issueSession(stored.user);
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
    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
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
    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
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

  private async issueSession(user: User): Promise<SessionResult> {
    const { raw, hash } = generateOpaqueToken();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
      this.prisma.authToken.create({
        data: {
          userId: user.id,
          type: 'refresh',
          tokenHash: hash,
          expiresAt: this.daysFromNow(REFRESH_TOKEN_DAYS),
        },
      }),
    ]);

    const fresh = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });

    return {
      accessToken: this.signAccessToken(fresh),
      refreshTokenRaw: raw,
      user: {
        id: fresh.id,
        email: fresh.email,
        name: fresh.name,
        role: fresh.role,
        tenantId: fresh.tenantId,
      },
    };
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

  private async findActiveUserByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: {
        email: { equals: email.trim(), mode: 'insensitive' },
        deletedAt: null,
        status: 'active',
      },
    });
  }

  private async upgradePasswordHashIfNeeded(
    userId: string,
    password: string,
    passwordHash: string,
  ): Promise<void> {
    if (!isDevPasswordHash(passwordHash)) return;
    const nextHash = await hashPassword(password);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: nextHash },
    });
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
