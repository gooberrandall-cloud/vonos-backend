import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { JobsService } from './jobs.service';

@Controller('jobs')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('statuses') statuses?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.jobsService.list({
      status,
      statuses: statuses
        ? statuses.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
      search,
      from,
      to,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post()
  @Roles('staff', 'manager', 'admin', 'super_admin')
  create(
    @Body()
    body: {
      reference: string;
      description: string;
      customerName?: string;
      customerId?: string;
      vehicleId?: string;
      hasQuote?: boolean;
      quoteAmount?: number;
      dueDate?: string;
    },
  ) {
    return this.jobsService.create(body);
  }

  @Get(':id/meta')
  getMeta(@Param('id') id: string) {
    return this.jobsService.getMeta(id);
  }

  @Get(':id/shell')
  getShell(@Param('id') id: string) {
    return this.jobsService.getShell(id);
  }

  @Get(':id/costs')
  getCosts(@Param('id') id: string) {
    return this.jobsService.getCosts(id);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.jobsService.getById(id);
  }

  @Patch(':id/status')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  advanceStatus(@Param('id') id: string) {
    return this.jobsService.advanceStatus(id);
  }

  @Patch(':id/vehicle')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  setVehicle(
    @Param('id') id: string,
    @Body() body: { vehicleId: string | null },
  ) {
    return this.jobsService.setVehicle(id, body.vehicleId ?? null);
  }

  @Patch(':id/billing')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  updateBilling(
    @Param('id') id: string,
    @Body()
    body: {
      hasQuote?: boolean;
      quoteAmount?: number | null;
      quoteNotes?: string | null;
      quoteValidUntil?: string | null;
      invoiceAmount?: number | null;
      invoiceNotes?: string | null;
    },
  ) {
    return this.jobsService.updateBilling(id, body);
  }

  @Patch(':id/qc')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  updateQc(
    @Param('id') id: string,
    @Body()
    body: {
      qcChecklist?: Record<string, boolean> | null;
      qcNotes?: string | null;
    },
  ) {
    return this.jobsService.updateQc(id, body);
  }

  @Post(':id/materials')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  addMaterial(
    @Param('id') id: string,
    @Body()
    body: {
      itemId?: string;
      name: string;
      quantity: number;
      unitCost: number;
      source?: string;
      sourceType?: 'shop' | 'internal' | 'external';
      sourceDepartment?: string;
      supplierId?: string;
    },
  ) {
    return this.jobsService.addMaterial(id, body);
  }

  @Patch(':id/materials/:materialId')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  updateMaterial(
    @Param('id') id: string,
    @Param('materialId') materialId: string,
    @Body()
    body: {
      name?: string;
      quantity?: number;
      unitCost?: number;
      source?: string | null;
    },
  ) {
    return this.jobsService.updateMaterial(id, materialId, body);
  }

  @Delete(':id/materials/:materialId')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  removeMaterial(
    @Param('id') id: string,
    @Param('materialId') materialId: string,
  ) {
    return this.jobsService.removeMaterial(id, materialId);
  }

  @Post(':id/labour')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  addLabour(
    @Param('id') id: string,
    @Body()
    body: {
      staffId: string;
      hours: number;
      rate: number;
    },
  ) {
    return this.jobsService.addLabour(id, body);
  }

  @Patch(':id/labour/:labourId')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  updateLabour(
    @Param('id') id: string,
    @Param('labourId') labourId: string,
    @Body()
    body: {
      staffId?: string;
      hours?: number;
      rate?: number;
    },
  ) {
    return this.jobsService.updateLabour(id, labourId, body);
  }

  @Delete(':id/labour/:labourId')
  @Roles('staff', 'manager', 'admin', 'super_admin')
  removeLabour(@Param('id') id: string, @Param('labourId') labourId: string) {
    return this.jobsService.removeLabour(id, labourId);
  }
}
