import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { VehiclesService } from './vehicles.service';

@Controller('vehicles')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Get()
  list() {
    return this.vehiclesService.list();
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.vehiclesService.getById(id);
  }

  @Post()
  create(
    @Body()
    body: {
      plateNumber: string;
      vin?: string;
      make: string;
      model: string;
      year?: number;
      ownerName: string;
      ownerPhone?: string;
    },
  ) {
    return this.vehiclesService.create(body);
  }
}
