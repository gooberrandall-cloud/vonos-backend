import { Injectable, Logger, Optional } from '@nestjs/common';
import { BaileysWhatsAppService } from './baileys-whatsapp.service';

export type WhatsAppSendResult = {
  sent: boolean;
  channel: 'baileys' | 'unipile' | 'cloud_api' | 'wa_me' | 'skipped';
  waMeUrl: string | null;
  toE164: string | null;
  error?: string;
  providerMessageId?: string;
};

/** Normalize common NG / intl phone strings to digits-only E.164 without '+'. */
export function toWhatsAppE164(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  digits = digits.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = `234${digits.slice(1)}`;
  }
  if (digits.length === 10 && /^[789]/.test(digits)) {
    digits = `234${digits}`;
  }
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

/** Unipile WhatsApp public attendee id — `{e164}@s.whatsapp.net`. */
export function toUnipileWhatsAppAttendeeId(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

export function buildWaMeUrl(e164: string, text: string): string {
  return `https://wa.me/${e164}?text=${encodeURIComponent(text)}`;
}

/**
 * Returns the new E.164 when `next` is a valid WhatsApp number that differs
 * from `previous` (so reformatting the same number does not re-send).
 */
export function phoneNewlySet(
  previous: string | null | undefined,
  next: string | null | undefined,
): string | null {
  const nextE164 = toWhatsAppE164(next);
  if (!nextE164) return null;
  const prevE164 = toWhatsAppE164(previous);
  if (prevE164 && prevE164 === nextE164) return null;
  return nextE164;
}

function unipileBaseUrl(): string | null {
  const raw = process.env.UNIPILE_DSN?.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, '');
  return `https://${raw.replace(/\/$/, '')}`;
}

function providerPref(): string {
  // Default MoovMart/Baileys; Unipile is an explicit or auto fallback.
  return (process.env.WHATSAPP_PROVIDER || 'baileys').trim().toLowerCase();
}

@Injectable()
export class WhatsAppNotifyService {
  private readonly logger = new Logger(WhatsAppNotifyService.name);

  constructor(
    @Optional() private readonly baileys?: BaileysWhatsAppService,
  ) {}

  isUnipileConfigured(): boolean {
    return Boolean(
      unipileBaseUrl() &&
        process.env.UNIPILE_API_KEY?.trim() &&
        process.env.UNIPILE_WHATSAPP_ACCOUNT_ID?.trim(),
    );
  }

  isCloudApiConfigured(): boolean {
    return Boolean(
      process.env.WHATSAPP_ACCESS_TOKEN?.trim() &&
        process.env.WHATSAPP_PHONE_NUMBER_ID?.trim(),
    );
  }

  /** Which outbound path will be used (for setup / smoke checks). */
  configuredChannel(): 'baileys' | 'unipile' | 'cloud_api' | 'wa_me' {
    const pref = providerPref();
    if (pref === 'unipile' && this.isUnipileConfigured()) return 'unipile';
    if (
      (pref === 'cloud_api' || pref === 'cloud-api') &&
      this.isCloudApiConfigured()
    ) {
      return 'cloud_api';
    }

    // MoovMart first whenever the WhatsApp Web session is live.
    if (this.baileys?.isConnected()) return 'baileys';

    // Still waiting on QR — report Baileys as the primary channel.
    if (pref === 'baileys' || pref === 'auto' || this.baileys?.isEnabled()) {
      return 'baileys';
    }

    if (this.isUnipileConfigured()) return 'unipile';
    if (this.isCloudApiConfigured()) return 'cloud_api';
    return 'wa_me';
  }

  publicSiteBase(): string {
    return (
      process.env.PUBLIC_SITE_URL ||
      process.env.WEB_ORIGIN?.split(',')[0] ||
      'http://localhost:3000'
    )
      .trim()
      .replace(/\/$/, '');
  }

  publicTrackUrl(args: {
    name: string;
    registration: string;
  }): string {
    const params = new URLSearchParams({
      name: args.name.trim(),
      reg: args.registration.trim(),
    });
    return `${this.publicSiteBase()}/track?${params.toString()}`;
  }

  publicJobTrackUrl(token: string): string {
    return `${this.publicSiteBase()}/job/${token}`;
  }

  composeStatusMessage(args: {
    ownerName: string;
    plate: string;
    statusLabel: string;
    trackUrl: string;
    shopName?: string;
  }): string {
    const shop = args.shopName?.trim() || 'Vonos';
    const who = args.ownerName.trim() || 'Customer';
    return (
      `${shop} update for ${who}:\n` +
      `Vehicle ${args.plate.trim().toUpperCase()} is now: ${args.statusLabel}.\n` +
      `Track progress: ${args.trackUrl}`
    );
  }

  /**
   * First-contact / test message when a customer or vehicle phone is saved.
   * Disable with WHATSAPP_WELCOME_ON_PHONE=false.
   */
  welcomeOnPhoneEnabled(): boolean {
    const raw = process.env.WHATSAPP_WELCOME_ON_PHONE?.trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') {
      return false;
    }
    return true;
  }

  composeWelcomeMessage(args: {
    customerName: string;
    shopName?: string;
  }): string {
    const shop = args.shopName?.trim() || 'Vonos';
    const who = args.customerName.trim() || 'Customer';
    return (
      `Hi ${who}, this is ${shop}.\n` +
      `We’ve saved your WhatsApp for job / service updates.\n` +
      `Reply OK if you received this — thanks.`
    );
  }

  /** Send welcome when a phone number is newly added or changed. */
  async notifyWelcomeIfNewPhone(args: {
    previousPhone?: string | null;
    nextPhone?: string | null;
    customerName: string;
    shopName?: string;
  }): Promise<WhatsAppSendResult | null> {
    if (!this.welcomeOnPhoneEnabled()) return null;
    const e164 = phoneNewlySet(args.previousPhone, args.nextPhone);
    if (!e164) return null;
    const message = this.composeWelcomeMessage({
      customerName: args.customerName,
      shopName: args.shopName,
    });
    return this.notifyCustomer({ phone: e164, message });
  }

  /**
   * Priority (MoovMart first, Unipile later):
   * 1. Baileys when connected (unless WHATSAPP_PROVIDER=unipile|cloud_api)
   * 2. Unipile (fallback)
   * 3. Meta Cloud API
   * 4. wa.me
   */
  async notifyCustomer(args: {
    phone: string | null | undefined;
    message: string;
    preferCloudApi?: boolean;
    templateParams?: {
      ownerName: string;
      plate: string;
      statusLabel: string;
      trackUrl: string;
    };
  }): Promise<WhatsAppSendResult> {
    const toE164 = toWhatsAppE164(args.phone);
    const waMeUrl = toE164 ? buildWaMeUrl(toE164, args.message) : null;

    if (!toE164) {
      return {
        sent: false,
        channel: 'skipped',
        waMeUrl: null,
        toE164: null,
        error: 'No valid customer phone number',
      };
    }

    const allowRemote = args.preferCloudApi !== false;
    const pref = providerPref();
    const forceUnipile = pref === 'unipile';
    const forceCloud = pref === 'cloud_api' || pref === 'cloud-api';
    const skipBaileys = forceUnipile || forceCloud;

    // 1) MoovMart / Baileys — primary when session is live
    if (
      allowRemote &&
      !skipBaileys &&
      this.baileys?.isConnected()
    ) {
      return this.sendViaBaileys({ toE164, message: args.message, waMeUrl });
    }

    // 2) Unipile — later / fallback (or WHATSAPP_PROVIDER=unipile)
    if (allowRemote && !forceCloud && this.isUnipileConfigured()) {
      return this.sendViaUnipile({
        toE164,
        message: args.message,
        waMeUrl,
      });
    }

    // 3) Meta Cloud API
    if (allowRemote && this.isCloudApiConfigured()) {
      return this.sendViaMetaCloudApi({
        toE164,
        message: args.message,
        waMeUrl,
        templateParams: args.templateParams,
      });
    }

    // Preferred Baileys but no session and no Unipile/Meta — surface QR hint
    if (
      allowRemote &&
      !skipBaileys &&
      this.baileys &&
      (pref === 'baileys' || this.baileys.isEnabled()) &&
      !this.baileys.isConnected()
    ) {
      return {
        sent: false,
        channel: 'baileys',
        waMeUrl,
        toE164,
        error:
          'Baileys WhatsApp not connected — scan QR in Notification Templates',
      };
    }

    this.logger.log(
      `WhatsApp remote send not configured — wa.me ready for ${toE164}`,
    );
    return {
      sent: false,
      channel: 'wa_me',
      waMeUrl,
      toE164,
    };
  }

  private async sendViaBaileys(args: {
    toE164: string;
    message: string;
    waMeUrl: string | null;
  }): Promise<WhatsAppSendResult> {
    try {
      const res = await this.baileys!.sendText(args.toE164, args.message);
      this.logger.log(
        `Baileys WhatsApp sent to ${args.toE164}${res.id ? ` id=${res.id}` : ''}`,
      );
      return {
        sent: true,
        channel: 'baileys',
        waMeUrl: args.waMeUrl,
        toE164: args.toE164,
        providerMessageId: res.id,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Baileys WhatsApp error: ${message}`);
      return {
        sent: false,
        channel: 'baileys',
        waMeUrl: args.waMeUrl,
        toE164: args.toE164,
        error: message,
      };
    }
  }

  private async sendViaUnipile(args: {
    toE164: string;
    message: string;
    waMeUrl: string | null;
  }): Promise<WhatsAppSendResult> {
    const base = unipileBaseUrl()!;
    const apiKey = process.env.UNIPILE_API_KEY!.trim();
    const accountId = process.env.UNIPILE_WHATSAPP_ACCOUNT_ID!.trim();
    const attendeeId = toUnipileWhatsAppAttendeeId(args.toE164);

    try {
      const form = new FormData();
      form.append('account_id', accountId);
      form.append('text', args.message);
      form.append('attendees_ids', attendeeId);

      const res = await fetch(`${base}/api/v1/chats`, {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          accept: 'application/json',
        },
        body: form,
      });

      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        message_id?: string;
        chat_id?: string;
        title?: string;
        detail?: string;
        message?: string;
      };

      if (!res.ok) {
        const err =
          body.detail ||
          body.title ||
          body.message ||
          `Unipile HTTP ${res.status}`;
        this.logger.warn(`Unipile WhatsApp failed to ${args.toE164}: ${err}`);
        return {
          sent: false,
          channel: 'unipile',
          waMeUrl: args.waMeUrl,
          toE164: args.toE164,
          error: err,
        };
      }

      const providerMessageId =
        body.message_id || body.id || body.chat_id || undefined;
      this.logger.log(
        `Unipile WhatsApp sent to ${args.toE164}${
          providerMessageId ? ` id=${providerMessageId}` : ''
        }`,
      );
      return {
        sent: true,
        channel: 'unipile',
        waMeUrl: args.waMeUrl,
        toE164: args.toE164,
        providerMessageId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Unipile WhatsApp error: ${message}`);
      return {
        sent: false,
        channel: 'unipile',
        waMeUrl: args.waMeUrl,
        toE164: args.toE164,
        error: message,
      };
    }
  }

  private async sendViaMetaCloudApi(args: {
    toE164: string;
    message: string;
    waMeUrl: string | null;
    templateParams?: {
      ownerName: string;
      plate: string;
      statusLabel: string;
      trackUrl: string;
    };
  }): Promise<WhatsAppSendResult> {
    try {
      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!.trim();
      const token = process.env.WHATSAPP_ACCESS_TOKEN!.trim();
      const apiVersion = process.env.WHATSAPP_API_VERSION?.trim() || 'v21.0';
      const templateName = process.env.WHATSAPP_TEMPLATE_NAME?.trim();
      const templateLang =
        process.env.WHATSAPP_TEMPLATE_LANG?.trim() || 'en';

      const payload = templateName
        ? {
            messaging_product: 'whatsapp',
            to: args.toE164,
            type: 'template',
            template: {
              name: templateName,
              language: { code: templateLang },
              components: [
                {
                  type: 'body',
                  parameters: [
                    args.templateParams?.ownerName ?? 'Customer',
                    args.templateParams?.plate ?? '',
                    args.templateParams?.statusLabel ?? '',
                    args.templateParams?.trackUrl ?? '',
                  ].map((text) => ({ type: 'text', text: String(text) })),
                },
              ],
            },
          }
        : {
            messaging_product: 'whatsapp',
            to: args.toE164,
            type: 'text',
            text: { preview_url: true, body: args.message },
          };

      const res = await fetch(
        `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        messages?: Array<{ id?: string }>;
        error?: { message?: string };
      };
      if (!res.ok) {
        const err =
          body.error?.message || `WhatsApp API HTTP ${res.status}`;
        this.logger.warn(`WhatsApp send failed to ${args.toE164}: ${err}`);
        return {
          sent: false,
          channel: 'cloud_api',
          waMeUrl: args.waMeUrl,
          toE164: args.toE164,
          error: err,
        };
      }
      const providerMessageId = body.messages?.[0]?.id;
      this.logger.log(
        `WhatsApp sent to ${args.toE164}${providerMessageId ? ` id=${providerMessageId}` : ''}${templateName ? ` template=${templateName}` : ''}`,
      );
      return {
        sent: true,
        channel: 'cloud_api',
        waMeUrl: args.waMeUrl,
        toE164: args.toE164,
        providerMessageId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`WhatsApp send error: ${message}`);
      return {
        sent: false,
        channel: 'cloud_api',
        waMeUrl: args.waMeUrl,
        toE164: args.toE164,
        error: message,
      };
    }
  }
}
