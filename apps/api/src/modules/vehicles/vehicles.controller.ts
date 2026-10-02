import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('make') make?: string,
  ) {
    return this.vehiclesService.list({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
      make,
    });
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.vehiclesService.getById(id);
  }

  @Get(':id/history')
  getHistory(@Param('id') id: string) {
    return this.vehiclesService.getHistory(id);
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

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body()
    body: {
      plateNumber?: string;
      vin?: string | null;
      make?: string;
      model?: string;
      year?: number | null;
      ownerName?: string;
      ownerPhone?: string | null;
    },
  ) {
    return this.vehiclesService.update(id, body);
  }
}
