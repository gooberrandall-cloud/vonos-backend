import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { SuppliersService } from './suppliers.service';

@Controller('suppliers')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get('kpi-summary')
  kpiSummary() {
    return this.suppliersService.kpiSummary();
  }

  @Get()
  list() {
    return this.suppliersService.list();
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.suppliersService.getById(id);
  }

  @Post()
  @Roles('staff', 'manager', 'admin', 'super_admin')
  create(
    @Body()
    body: {
      name: string;
      contactName?: string;
      email?: string;
      phone?: string;
      address?: string;
      notes?: string;
    },
  ) {
    return this.suppliersService.create(body);
  }

  @Patch(':id')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  update(
    @Param('id') id: string,
    @Body()
    body: Partial<{
      name: string;
      contactName: string;
      email: string;
      phone: string;
      address: string;
      notes: string;
    }>,
  ) {
    return this.suppliersService.update(id, body);
  }
}
