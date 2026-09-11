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
import { isClearanceTenantId } from '../tenants/tenantIds';
import { userCanAccessVagPortal } from '../utils/vagPortalAccess';

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
      const [tenantRole, allowedTenantCodes] = await Promise.all([
        this.authService.resolveTenantRoleContext(
          payload.sub,
          payload.tokenVersion,
        ),
        this.authService.resolveAllowedTenantCodesForSession({
          id: payload.sub,
          tenantId: payload.tenantId,
          role: payload.role,
        }),
      ]);
      request.user = {
        sub: payload.sub,
        tenantId: payload.tenantId,
        role: payload.role,
        tenantRolePermissions: tenantRole.permissions,
        tenantRoleName: tenantRole.name,
        allowedTenantCodes,
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
    const { tenantId, allowedTenantCodes = [] } = request.user;
    const viewingHeader = request.headers['x-viewing-tenant'];
    const viewingTenant = Array.isArray(viewingHeader)
      ? viewingHeader[0]
      : viewingHeader;
    const queryTenantRaw = request.query['tenantId'];
    const queryTenant = Array.isArray(queryTenantRaw)
      ? queryTenantRaw[0]
      : queryTenantRaw;
    const requestedScope = viewingTenant?.trim() || queryTenant?.trim() || null;

    if (userCanAccessVagPortal(request.user)) {
      request.tenantScope = requestedScope;
      return true;
    }

    if (
      requestedScope &&
      allowedTenantCodes.length > 1 &&
      isClearanceTenantId(requestedScope, allowedTenantCodes)
    ) {
      request.tenantScope = requestedScope;
      return true;
    }

    request.tenantScope = tenantId;
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
    // VAG can act on any tenant-scoped write that managers/admins can.
    if (request.user.role === 'super_admin') return true;
    // HR portal users may call endpoints that list `super_admin` as required
    // (group overview / cross-tenant HRM). Handlers still enforce permissions.
    if (
      required.includes('super_admin') &&
      userCanAccessVagPortal(request.user)
    ) {
      return true;
    }
    return required.includes(request.user.role);
  }
}
