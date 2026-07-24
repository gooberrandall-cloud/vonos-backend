import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CafeTablesController } from './cafe-tables.controller';
import { CafeTablesService } from './cafe-tables.service';

@Module({
  imports: [AuthModule],
  controllers: [CafeTablesController],
  providers: [CafeTablesService],
  exports: [CafeTablesService],
})
export class CafeTablesModule {}
