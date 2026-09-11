import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CmsController } from './cms.controller';
import { CmsService } from './cms.service';
import { PublicCmsController } from './public-cms.controller';

@Module({
  imports: [AuthModule],
  controllers: [CmsController, PublicCmsController],
  providers: [CmsService],
  exports: [CmsService],
})
export class CmsModule {}
