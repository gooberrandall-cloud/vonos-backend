import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvoiceSettingsController } from './invoice-settings.controller';
import { InvoiceSettingsService } from './invoice-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [InvoiceSettingsController],
  providers: [InvoiceSettingsService],
  exports: [InvoiceSettingsService],
})
export class InvoiceSettingsModule {}
