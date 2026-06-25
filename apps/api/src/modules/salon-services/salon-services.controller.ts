import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { SalonServicesService } from './salon-services.service';

@Controller('salon-services')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class SalonServicesController {
  constructor(private readonly salonServicesService: SalonServicesService) {}

  @Get()
  list() {
    return this.salonServicesService.list();
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.salonServicesService.getById(id);
  }

  @Post()
  create(
    @Body()
    body: {
      name: string;
      durationMinutes?: number;
      price: number;
      currency?: string;
    },
  ) {
    return this.salonServicesService.create(body);
  }
}
