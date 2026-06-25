import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ItemsModule } from '../items/items.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [AuthModule, ItemsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
