import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

type PaystackInitializeResponse = {
  status: boolean;
  message: string;
  data?: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
};

type PaystackVerifyResponse = {
  status: boolean;
  message: string;
  data?: {
    status: string;
    reference: string;
    amount: number;
    currency: string;
    paid_at?: string;
    metadata?: Record<string, unknown>;
  };
};

@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);

  private get secretKey(): string {
    return (process.env.PAYSTACK_SECRET_KEY ?? '').trim();
  }

  get publicKey(): string {
    return (process.env.PAYSTACK_PUBLIC_KEY ?? '').trim();
  }

  isConfigured(): boolean {
    return Boolean(this.secretKey);
  }

  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    if (!this.secretKey || !signature) return false;
    const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const digest = createHmac('sha512', this.secretKey).update(payload).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  async initializeTransaction(args: {
    email: string;
    amountKobo: number;
    reference: string;
    callbackUrl: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ authorizationUrl: string; accessCode: string; reference: string }> {
    if (!this.secretKey) {
      throw new BadRequestException(
        'Paystack is not configured. Set PAYSTACK_SECRET_KEY on the API.',
      );
    }

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: args.email,
        amount: args.amountKobo,
        reference: args.reference,
        callback_url: args.callbackUrl,
        metadata: args.metadata ?? {},
        currency: 'NGN',
      }),
    });

    const body = (await response.json()) as PaystackInitializeResponse;
    if (!response.ok || !body.status || !body.data) {
      this.logger.error(`Paystack initialize failed: ${body.message}`);
      throw new InternalServerErrorException(
        body.message || 'Unable to start Paystack checkout',
      );
    }

    return {
      authorizationUrl: body.data.authorization_url,
      accessCode: body.data.access_code,
      reference: body.data.reference,
    };
  }

  async verifyTransaction(reference: string): Promise<PaystackVerifyResponse['data']> {
    if (!this.secretKey) {
      throw new BadRequestException('Paystack is not configured');
    }

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${this.secretKey}` },
      },
    );

    const body = (await response.json()) as PaystackVerifyResponse;
    if (!response.ok || !body.status) {
      throw new BadRequestException(body.message || 'Paystack verification failed');
    }

    return body.data;
  }
}
