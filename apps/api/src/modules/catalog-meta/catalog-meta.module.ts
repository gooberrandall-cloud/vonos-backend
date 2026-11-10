import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogMetaController } from './catalog-meta.controller';
import { CatalogMetaService } from './catalog-meta.service';

@Module({
  imports: [AuthModule],
  controllers: [CatalogMetaController],
  providers: [CatalogMetaService],
  exports: [CatalogMetaService],
})
export class CatalogMetaModule {}
