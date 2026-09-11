import { Injectable, Logger } from '@nestjs/common';

export type WhatsAppSendResult = {
  sent: boolean;
  channel: 'cloud_api' | 'wa_me' | 'skipped';
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
  // Local NG mobile: 0803… / 0701… → 234803…
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = `234${digits.slice(1)}`;
  }
  // NG without country: 803… (10 digits)
  if (digits.length === 10 && /^[789]/.test(digits)) {
    digits = `234${digits}`;
  }
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

export function buildWaMeUrl(e164: string, text: string): string {
  return `https://wa.me/${e164}?text=${encodeURIComponent(text)}`;
}

@Injectable()
export class WhatsAppNotifyService {
  private readonly logger = new Logger(WhatsAppNotifyService.name);

  isCloudApiConfigured(): boolean {
    return Boolean(
      process.env.WHATSAPP_ACCESS_TOKEN?.trim() &&
        process.env.WHATSAPP_PHONE_NUMBER_ID?.trim(),
    );
  }

  publicTrackUrl(args: {
    name: string;
    registration: string;
  }): string {
    const base = (
      process.env.PUBLIC_SITE_URL ||
      process.env.WEB_ORIGIN?.split(',')[0] ||
      'http://localhost:3000'
    )
      .trim()
      .replace(/\/$/, '');
    const params = new URLSearchParams({
      name: args.name.trim(),
      reg: args.registration.trim(),
    });
    return `${base}/track?${params.toString()}`;
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
   * Send via Meta WhatsApp Cloud API when configured; otherwise return a
   * wa.me deep link for staff to open (Phase 1 style).
   *
   * For true outbound “notifications” (customer has not messaged first), Meta
   * requires an approved template. Set WHATSAPP_TEMPLATE_NAME (+ optional
   * WHATSAPP_TEMPLATE_LANG, default en). Template body params:
   *   {{1}} owner/customer name
   *   {{2}} plate
   *   {{3}} status label
   *   {{4}} track URL
   * If no template is configured, we send a free-form text message (only works
   * inside the 24h customer-care window).
   */
  async notifyCustomer(args: {
    phone: string | null | undefined;
    message: string;
    /** When false, never call Cloud API — only build wa.me. */
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

    const useCloud =
      args.preferCloudApi !== false && this.isCloudApiConfigured();

    if (!useCloud) {
      this.logger.log(
        `WhatsApp Cloud API not configured — wa.me ready for ${toE164}`,
      );
      return {
        sent: false,
        channel: 'wa_me',
        waMeUrl,
        toE164,
      };
    }

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
            to: toE164,
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
            to: toE164,
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
        this.logger.warn(`WhatsApp send failed to ${toE164}: ${err}`);
        return {
          sent: false,
          channel: 'cloud_api',
          waMeUrl,
          toE164,
          error: err,
        };
      }
      const providerMessageId = body.messages?.[0]?.id;
      this.logger.log(
        `WhatsApp sent to ${toE164}${providerMessageId ? ` id=${providerMessageId}` : ''}${templateName ? ` template=${templateName}` : ''}`,
      );
      return {
        sent: true,
        channel: 'cloud_api',
        waMeUrl,
        toE164,
        providerMessageId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`WhatsApp send error: ${message}`);
      return {
        sent: false,
        channel: 'cloud_api',
        waMeUrl,
        toE164,
        error: message,
      };
    }
  }
}
