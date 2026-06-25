import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

@Module({
  imports: [AuthModule],
  controllers: [LedgerController],
  providers: [LedgerService],
})
export class LedgerModule {}
