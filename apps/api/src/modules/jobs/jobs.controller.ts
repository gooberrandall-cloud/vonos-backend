import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.jobsService.list({
      status,
      search,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post()
  create(
    @Body()
    body: {
      reference: string;
      description: string;
      customerName?: string;
      vehicleId?: string;
      hasQuote?: boolean;
      quoteAmount?: number;
      dueDate?: string;
    },
  ) {
    return this.jobsService.create(body);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.jobsService.getById(id);
  }

  @Patch(':id/status')
  advanceStatus(@Param('id') id: string) {
    return this.jobsService.advanceStatus(id);
  }
}
