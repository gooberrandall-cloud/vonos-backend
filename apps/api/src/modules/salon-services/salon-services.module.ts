import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SalonServicesController } from './salon-services.controller';
import { SalonServicesService } from './salon-services.service';

@Module({
  imports: [AuthModule],
  controllers: [SalonServicesController],
  providers: [SalonServicesService],
  exports: [SalonServicesService],
})
export class SalonServicesModule {}
