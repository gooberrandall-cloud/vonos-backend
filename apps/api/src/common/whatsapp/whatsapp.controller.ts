import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../decorators/roles.decorator';
import { JwtAuthGuard, RolesGuard } from '../guards/auth.guards';
import { BaileysWhatsAppService } from './baileys-whatsapp.service';
import { WhatsAppNotifyService } from './whatsapp-notify.service';

/**
 * MoovMart-style WhatsApp ops for Railway (long-lived API).
 * Link phone via Baileys QR, or rely on Unipile/Meta when configured.
 */
@Controller('whatsapp')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WhatsAppController {
  constructor(
    private readonly baileys: BaileysWhatsAppService,
    private readonly notify: WhatsAppNotifyService,
  ) {}

  @Get('status')
  @Roles('super_admin', 'admin')
  status() {
    return {
      channel: this.notify.configuredChannel(),
      unipile: this.notify.isUnipileConfigured(),
      metaCloud: this.notify.isCloudApiConfigured(),
      baileys: this.baileys.getStatus(),
    };
  }

  /** PNG data-URL of current Baileys QR (scan with the business WhatsApp). */
  @Get('baileys/qr')
  @Roles('super_admin', 'admin')
  async baileysQr() {
    const status = this.baileys.getStatus();
    if (!status.enabled) {
      return {
        ...status,
        qrDataUrl: null,
        hint: 'Set WHATSAPP_PROVIDER=baileys and restart the API',
      };
    }
    if (status.connected) {
      return { ...status, qrDataUrl: null, hint: 'Already connected' };
    }
    if (!status.hasQr) {
      // Only kick start if nothing is already connecting / reconnecting.
      if (!this.baileys.isBusy()) {
        void this.baileys.start();
      }
      return {
        ...status,
        qrDataUrl: null,
        hint: 'Waiting for QR — refresh in a few seconds',
      };
    }
    const qrDataUrl = await this.baileys.getQrDataUrl();
    return { ...status, qrDataUrl };
  }

  @Post('baileys/reconnect')
  @Roles('super_admin', 'admin')
  async baileysReconnect(@Body() body?: { clearSession?: boolean }) {
    const status = await this.baileys.reconnect(Boolean(body?.clearSession));
    return status;
  }

  /** Smoke-send a status-style message (Baileys / Unipile / Meta / wa.me). */
  @Post('test')
  @Roles('super_admin', 'admin')
  async test(@Body() body: { phone: string; message?: string }) {
    const phone = body?.phone?.trim();
    if (!phone) {
      return {
        sent: false,
        channel: 'skipped' as const,
        waMeUrl: null,
        toE164: null,
        error: 'phone required',
      };
    }
    const message =
      body.message?.trim() ||
      this.notify.composeStatusMessage({
        ownerName: 'Test Owner',
        plate: 'TEST-001',
        statusLabel: 'In Progress',
        trackUrl: this.notify.publicJobTrackUrl('test-token'),
        shopName: 'Vonos Mechanic',
      });
    return this.notify.notifyCustomer({ phone, message });
  }
}
