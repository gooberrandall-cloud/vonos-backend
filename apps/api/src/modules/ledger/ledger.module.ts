import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

@Module({
  imports: [AuthModule, ExpensesModule],
  controllers: [LedgerController],
  providers: [LedgerService],
})
export class LedgerModule {}
