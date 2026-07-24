import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '../decorators/roles.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthService } from '../../modules/auth/auth.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      user?: AuthenticatedUser;
    }>();
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = authHeader.slice(7);
    try {
      const payload = await this.authService.validateAccessToken(token);
      request.user = {
        sub: payload.sub,
        tenantId: payload.tenantId,
        role: payload.role,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }
}

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      user: AuthenticatedUser;
      tenantScope: string | null;
      headers: Record<string, string | string[] | undefined>;
      query: Record<string, string | string[] | undefined>;
    }>();
    const { tenantId, role } = request.user;
    const viewingHeader = request.headers['x-viewing-tenant'];
    const viewingTenant = Array.isArray(viewingHeader)
      ? viewingHeader[0]
      : viewingHeader;
    const queryTenantRaw = request.query['tenantId'];
    const queryTenant = Array.isArray(queryTenantRaw)
      ? queryTenantRaw[0]
      : queryTenantRaw;

    if (role === 'super_admin') {
      request.tenantScope =
        viewingTenant?.trim() || queryTenant?.trim() || null;
    } else {
      request.tenantScope = tenantId;
    }
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<string[]>(
      ROLES_KEY,
      context.getHandler(),
    );
    if (!required?.length) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    return required.includes(request.user.role);
  }
}
