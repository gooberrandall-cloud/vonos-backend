import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OverviewController } from './overview.controller';
import { OverviewInternalController } from './overview-internal.controller';
import { OverviewService } from './overview.service';

@Module({
  imports: [AuthModule],
  controllers: [OverviewController, OverviewInternalController],
  providers: [OverviewService],
})
export class OverviewModule {}
