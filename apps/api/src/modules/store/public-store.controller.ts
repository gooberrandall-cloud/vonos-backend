import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { StoreFulfillmentType } from '@prisma/client';
import { PaystackService } from './paystack.service';
import { StoreCatalogService } from './store-catalog.service';
import { StoreCheckoutService } from './store-checkout.service';

type CheckoutBody = {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  registration?: string;
  fulfillment: StoreFulfillmentType;
  notes?: string;
  lines: Array<{ itemId: string; qty: number }>;
  callbackUrl: string;
};

/** Public storefront — no JWT. Catalog from VSP retail items only. */
@Controller('public/store')
export class PublicStoreController {
  constructor(
    private readonly catalog: StoreCatalogService,
    private readonly checkout: StoreCheckoutService,
    private readonly paystack: PaystackService,
  ) {}

  @Get('catalog')
  listCatalog(
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('sort') sort?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.catalog.listCatalog({
      search,
      category,
      sort,
      minPrice: minPrice != null && minPrice !== '' ? Number(minPrice) : undefined,
      maxPrice: maxPrice != null && maxPrice !== '' ? Number(maxPrice) : undefined,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('catalog/:sku')
  async getCatalogItem(@Param('sku') sku: string) {
    const item = await this.catalog.getBySku(sku);
    if (!item) {
      throw new NotFoundException('Part not found');
    }
    return item;
  }

  @Post('checkout')
  checkoutOrder(@Body() body: CheckoutBody) {
    if (!body.callbackUrl?.trim()) {
      throw new BadRequestException('callbackUrl is required');
    }
    if (!body.customerName?.trim() || !body.customerEmail?.trim()) {
      throw new BadRequestException('Customer name and email are required');
    }
    if (!body.lines?.length) {
      throw new BadRequestException('Cart is empty');
    }
    return this.checkout.createCheckout(body);
  }

  @Get('orders/:reference')
  getOrder(@Param('reference') reference: string) {
    return this.checkout.getOrder(reference);
  }

  @Post('orders/:reference/confirm')
  confirmOrder(@Param('reference') reference: string) {
    return this.checkout.confirmPaid(reference);
  }

  @Post('webhooks/paystack')
  paystackWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string | undefined,
    @Body()
    body: {
      event?: string;
      data?: { reference?: string; status?: string };
    },
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(body));
    if (!this.paystack.verifyWebhookSignature(rawBody, signature)) {
      throw new BadRequestException('Invalid Paystack signature');
    }
    return this.checkout.handlePaystackWebhook({
      event: body.event ?? '',
      data: body.data,
    });
  }
}
