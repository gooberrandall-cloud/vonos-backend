import { Module } from '@nestjs/common';
import { PaystackService } from './paystack.service';
import { PublicStoreController } from './public-store.controller';
import { StoreCatalogService } from './store-catalog.service';
import { StoreCheckoutService } from './store-checkout.service';

@Module({
  controllers: [PublicStoreController],
  providers: [StoreCatalogService, StoreCheckoutService, PaystackService],
  exports: [StoreCatalogService, StoreCheckoutService, PaystackService],
})
export class StoreModule {}
