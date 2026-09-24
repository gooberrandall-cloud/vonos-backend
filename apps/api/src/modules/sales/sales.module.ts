import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { PublicInvoicesController } from './public-invoices.controller';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [AuthModule, InvoicesModule],
  controllers: [SalesController, PublicInvoicesController],
  providers: [SalesService],
})
export class SalesModule {}
