import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvoicesModule } from '../invoices/invoices.module';
import {
  StockMovementsController,
  TransfersController,
} from './stock-movements.controller';
import { StockMovementsService } from './stock-movements.service';

@Module({
  imports: [AuthModule, InvoicesModule],
  controllers: [StockMovementsController, TransfersController],
  providers: [StockMovementsService],
})
export class StockMovementsModule {}
