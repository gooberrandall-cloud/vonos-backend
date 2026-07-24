import { SetMetadata } from '@nestjs/common';
import type { Role } from '@vonos/types';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthenticatedUser {
  sub: string;
  tenantId: string | null;
  role: Role;
}
