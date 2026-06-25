import {
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
import type { LoginResponse, LoginSuccessResponse } from '@vonos/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/auth.guards';
import { REFRESH_COOKIE_NAME } from './auth.constants';
import { AuthService, type SessionResult } from './auth.service';

interface LoginDto {
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
    this.setRefreshCookie(res, result.refreshTokenRaw);
    return stripRefreshToken(result);
  }

  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginSuccessResponse> {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as
      | string
      | undefined;
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    const result = await this.authService.refreshSession(refreshToken);
    this.setRefreshCookie(res, result.refreshTokenRaw);
    return stripRefreshToken(result);
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

  private setRefreshCookie(res: Response, token: string): void {
    const secure = process.env.NODE_ENV === 'production';
    res.cookie(REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
  }
}
