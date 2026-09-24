import { ForbiddenException } from '@nestjs/common';
import { canAccessVagPortal } from '@vonos/types';
import type { AuthenticatedUser } from '../decorators/roles.decorator';

export function userCanAccessVagPortal(user: AuthenticatedUser): boolean {
  return canAccessVagPortal({
    role: user.role,
    tenantRoleName: user.tenantRoleName,
  });
}

export function assertVagPortalAccess(user: AuthenticatedUser): void {
  if (!userCanAccessVagPortal(user)) {
    throw new ForbiddenException('VAG admin access required');
  }
}
