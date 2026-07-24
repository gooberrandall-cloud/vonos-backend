import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VariationsController } from './variations.controller';
import { VariationsService } from './variations.service';

@Module({
  imports: [AuthModule],
  controllers: [VariationsController],
  providers: [VariationsService],
})
export class VariationsModule {}
