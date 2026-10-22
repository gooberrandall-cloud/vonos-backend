import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CashRegisterController } from './cash-register.controller';
import { CashRegisterService } from './cash-register.service';

@Module({
  imports: [AuthModule],
  controllers: [CashRegisterController],
  providers: [CashRegisterService],
  exports: [CashRegisterService],
})
export class CashRegisterModule {}
