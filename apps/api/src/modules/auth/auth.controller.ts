import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type {
  LoginResponse,
  LoginSuccessResponse,
  SessionDebugResponse,
} from '@vonos/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/auth.guards';
import { REFRESH_COOKIE_NAME } from './auth.constants';
import { AuthService, type SessionResult } from './auth.service';

interface LoginDto {
  /** Email address or username. */
  email: string;
  password: string;
}

interface VerifyTwoFactorDto {
  challengeToken: string;
  code: string;
}

interface ResetPasswordDto {
  token: string;
  password: string;
}

interface AcceptInviteDto {
  token: string;
  password: string;
  name?: string;
}

interface TotpCodeDto {
  code: string;
}

function stripRefreshToken(result: SessionResult): LoginSuccessResponse {
  const { refreshTokenRaw, ...response } = result;
  void refreshTokenRaw;
  return response;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const result = await this.authService.login(body);
    if ('requiresTwoFactor' in result) {
      return result;
    }
    if (!result.refreshTokenRaw) {
      throw new UnauthorizedException('Missing refresh token');
    }
    this.setRefreshCookie(res, result.refreshTokenRaw);
    return stripRefreshToken(result);
  }

  @Post('verify-2fa')
  async verifyTwoFactor(
    @Body() body: VerifyTwoFactorDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginSuccessResponse> {
    const result = await this.authService.verifyTwoFactor(
      body.challengeToken,
      body.code,
    );
    if (!result.refreshTokenRaw) {
      throw new UnauthorizedException('Missing refresh token');
    }
    this.setRefreshCookie(res, result.refreshTokenRaw);
    return stripRefreshToken(result);
  }

  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body?: { tenantId?: string | null },
  ): Promise<LoginSuccessResponse> {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as
      | string
      | undefined;
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    const result = await this.authService.refreshSession(
      refreshToken,
      body?.tenantId,
    );
    // Slide cookie maxAge with the same value — do not mint a new opaque token.
    if (result.refreshTokenRaw) {
      this.setRefreshCookie(res, result.refreshTokenRaw);
    }
    return stripRefreshToken(result);
  }

  /** Permissions / profile sync without touching the refresh cookie. */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<import('@vonos/types').LoginUser> {
    const preferred =
      typeof req.query?.tenantId === 'string' ? req.query.tenantId : null;
    return this.authService.getSessionProfile(user.sub, preferred);
  }

  /**
   * Read-only probe for early-logout debugging.
   * Call from the browser while logged in (credentials included) so the
   * refresh cookie is sent. Does not rotate or clear the session.
   */
  @Get('session-debug')
  sessionDebug(@Req() req: Request): Promise<SessionDebugResponse> {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as
      | string
      | undefined;
    const authHeader = req.headers.authorization;
    const accessToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : undefined;
    const cookie = this.refreshCookieBase();
    return this.authService.inspectSessionDebug({
      refreshTokenRaw: refreshToken,
      accessTokenRaw: accessToken || undefined,
      requestOrigin:
        typeof req.headers.origin === 'string' ? req.headers.origin : null,
      cookieSameSite: cookie.sameSite,
      cookieSecure: cookie.secure,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post('switch-tenant')
  switchWorkingTenant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { tenantCode: string },
  ): Promise<LoginSuccessResponse> {
    const code = body?.tenantCode?.trim();
    if (!code) {
      throw new BadRequestException('tenantCode is required');
    }
    return this.authService.switchWorkingTenant(user.sub, code);
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as
      | string
      | undefined;
    await this.authService.logout(refreshToken);
    this.clearRefreshCookie(res);
    return { success: true };
  }

  @Post('forgot-password')
  forgotPassword(@Body() body: { email: string }) {
    return this.authService.forgotPassword(body.email);
  }

  @Get('reset-password/:token')
  validateResetToken(@Param('token') token: string) {
    return this.authService.validateResetToken(token);
  }

  @Post('reset-password')
  async resetPassword(@Body() body: ResetPasswordDto) {
    await this.authService.resetPassword(body.token, body.password);
    return { success: true };
  }

  @Get('invite/:token')
  getInvite(@Param('token') token: string) {
    return this.authService.getInvite(token);
  }

  @Post('invite/accept')
  async acceptInvite(
    @Body() body: AcceptInviteDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginSuccessResponse> {
    const result = await this.authService.acceptInvite(
      body.token,
      body.password,
      body.name,
    );
    if (!result.refreshTokenRaw) {
      throw new UnauthorizedException('Missing refresh token');
    }
    this.setRefreshCookie(res, result.refreshTokenRaw);
    return stripRefreshToken(result);
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/setup')
  setupTwoFactor(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.setupTwoFactor(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/confirm')
  confirmTwoFactor(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: TotpCodeDto,
  ) {
    return this.authService.confirmTwoFactor(user.sub, body.code);
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/disable')
  disableTwoFactor(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: TotpCodeDto,
  ) {
    return this.authService.disableTwoFactor(user.sub, body.code);
  }

  /**
   * Cross-origin (Vercel web → Railway API) needs SameSite=None + Secure so
   * credentialed POSTs to /auth/refresh include the cookie. Same-site local
   * (localhost:3000 → :3001 can still be treated cross-site by port; we detect
   * explicitly via COOKIE_SAMESITE or fall back to production = none).
   */
  private refreshCookieBase() {
    const sameSiteEnv = process.env.COOKIE_SAMESITE?.toLowerCase();
    const crossOrigin =
      sameSiteEnv === 'none' ||
      (sameSiteEnv !== 'lax' && process.env.NODE_ENV === 'production');
    return {
      httpOnly: true,
      secure: crossOrigin || process.env.NODE_ENV === 'production',
      sameSite: (crossOrigin ? 'none' : 'lax') as 'none' | 'lax',
      path: '/',
    };
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE_NAME, token, {
      ...this.refreshCookieBase(),
      // Root path so /auth/refresh always receives the cookie (and any
      // future auth routes under a global prefix still work).
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  private clearRefreshCookie(res: Response): void {
    const base = this.refreshCookieBase();
    res.clearCookie(REFRESH_COOKIE_NAME, base);
    // Also clear legacy path-scoped / SameSite=Lax cookies from earlier deploys.
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
    res.clearCookie(REFRESH_COOKIE_NAME, {
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
  }
}
