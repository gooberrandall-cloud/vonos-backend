import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { resolveHrmAccess } from '@vonos/types';
import type { AuthenticatedUser } from '../decorators/roles.decorator';
import {
  HRM_ACCESS_KEY,
  type HrmRouteRequirement,
} from '../decorators/hrmAccess.decorator';

/**
 * Gates `/hrm/*` so only HR / Accountant / Admin users reach the module.
 *
 * Handlers marked `@HrmAccess('any')` stay reachable by everyone but must
 * scope their own result (see the payroll endpoints). Everything else —
 * including anything newly added without a decorator — requires full HRM
 * access.
 */
@Injectable()
export class HrmAccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requirement = this.reflector.getAllAndOverride<
      HrmRouteRequirement | undefined
    >(HRM_ACCESS_KEY, [context.getHandler(), context.getClass()]);
    if (requirement === 'any') return true;

    const request = context.switchToHttp().getRequest<{
      user: AuthenticatedUser;
    }>();
    const access = resolveHrmAccess({
      role: request.user.role,
      tenantRoleName: request.user.tenantRoleName,
      tenantRolePermissions: request.user.tenantRolePermissions,
    });
    if (access === 'full') return true;

    throw new ForbiddenException(
      'HRM access is limited to HR, Accountant and Admin users',
    );
  }
}
