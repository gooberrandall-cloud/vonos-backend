import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AuditLogEntry } from '@vonos/types';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { AuditService } from './audit.service';

@Controller('audit')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  list(
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditLogEntry[]> {
    return this.auditService.list({
      entityType,
      entityId,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('recent')
  recent(@Query('limit') limit?: string): Promise<AuditLogEntry[]> {
    return this.auditService.listRecent(limit ? Number(limit) : 10);
  }
}
