import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentAccountsController } from './payment-accounts.controller';
import { PaymentAccountsService } from './payment-accounts.service';

@Module({
  imports: [AuthModule],
  controllers: [PaymentAccountsController],
  providers: [PaymentAccountsService],
  exports: [PaymentAccountsService],
})
export class PaymentAccountsModule {}
