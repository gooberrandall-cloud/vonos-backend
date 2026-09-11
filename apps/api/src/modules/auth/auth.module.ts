import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { ACCESS_TOKEN_TTL } from './auth.constants';
import { AuthMailService } from './auth-mail.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
      signOptions: {
        expiresIn: (process.env.JWT_ACCESS_EXPIRES ??
          ACCESS_TOKEN_TTL) as StringValue,
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthMailService,
    JwtAuthGuard,
    TenantGuard,
    RolesGuard,
  ],
  exports: [
    JwtModule,
    JwtAuthGuard,
    TenantGuard,
    RolesGuard,
    AuthService,
    AuthMailService,
  ],
})
export class AuthModule {}
