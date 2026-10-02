import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ItemsModule } from '../items/items.module';
import { AuditModule } from '../audit/audit.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportActionsService } from './report-actions.service';

@Module({
  imports: [AuthModule, ItemsModule, AuditModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportActionsService],
})
export class ReportsModule {}
