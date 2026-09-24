import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  ForbiddenException,
  UseGuards,
  Req,
} from '@nestjs/common';
import type {
  CreateTenantRoleRequest,
  ImportTenantRolesRequest,
  UpdateTenantRoleRequest,
} from '@vonos/types';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { TenantRolesService } from './tenant-roles.service';
import { userHasPermission } from '../../common/utils/userPermissions';

@Controller('tenant-roles')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class TenantRolesController {
  constructor(private readonly service: TenantRolesService) {}

  @Get()
  list(@Query('search') search?: string) {
    return this.service.list({ search });
  }

  /** Create/update/delete require roles.* keys (HR defaults include them). */
  @Post()
  @Roles('admin', 'manager', 'staff', 'super_admin')
  create(
    @Body() dto: CreateTenantRoleRequest,
    @Req() req: { user: AuthenticatedUser },
  ) {
    if (!userHasPermission(req.user, 'roles.create')) {
      throw new ForbiddenException('Missing roles.create');
    }
    return this.service.create(dto);
  }

  @Post('import')
  @Roles('admin', 'manager', 'staff', 'super_admin')
  importRoles(
    @Body() dto: ImportTenantRolesRequest,
    @Req() req: { user: AuthenticatedUser },
  ) {
    if (!userHasPermission(req.user, 'roles.create')) {
      throw new ForbiddenException('Missing roles.create');
    }
    return this.service.importRoles(dto);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.service.getById(id);
  }

  @Patch(':id')
  @Roles('admin', 'manager', 'staff', 'super_admin')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTenantRoleRequest,
    @Req() req: { user: AuthenticatedUser },
  ) {
    if (!userHasPermission(req.user, 'roles.update')) {
      throw new ForbiddenException('Missing roles.update');
    }
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin', 'manager', 'staff', 'super_admin')
  remove(
    @Param('id') id: string,
    @Req() req: { user: AuthenticatedUser },
  ) {
    if (!userHasPermission(req.user, 'roles.delete')) {
      throw new ForbiddenException('Missing roles.delete');
    }
    return this.service.remove(id);
  }
}
