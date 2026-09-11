import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvoiceHubService } from './invoice-hub.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

@Module({
  imports: [AuthModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoiceHubService],
  exports: [InvoiceHubService, InvoicesService],
})
export class InvoicesModule {}
