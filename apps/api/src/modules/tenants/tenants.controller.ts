import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import type { UpdateTenantConfigRequest } from '@vonos/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/auth.guards';
import { TenantsService } from './tenants.service';

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get(':id/config')
  @UseGuards(JwtAuthGuard)
  getConfig(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tenantsService.getConfig(id, user.tenantId, user.role);
  }

  @Patch(':id/config')
  @UseGuards(JwtAuthGuard)
  updateConfig(
    @Param('id') id: string,
    @Body() body: UpdateTenantConfigRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenantsService.updateConfig(id, user.tenantId, user.role, body);
  }
}
