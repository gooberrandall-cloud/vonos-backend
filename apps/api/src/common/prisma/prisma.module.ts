import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenantDbService } from './tenant-db.service';

@Global()
@Module({
  providers: [PrismaService, TenantDbService],
  exports: [PrismaService, TenantDbService],
})
export class PrismaModule {}
