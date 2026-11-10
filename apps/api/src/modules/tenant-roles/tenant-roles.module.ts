import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantRolesController } from './tenant-roles.controller';
import { TenantRolesService } from './tenant-roles.service';

@Module({
  imports: [AuthModule],
  controllers: [TenantRolesController],
  providers: [TenantRolesService],
  exports: [TenantRolesService],
})
export class TenantRolesModule {}
