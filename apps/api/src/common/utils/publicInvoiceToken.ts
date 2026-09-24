import { createHmac, timingSafeEqual } from 'crypto';

function shareSecret(): string {
  return (
    process.env.INVOICE_SHARE_SECRET ||
    process.env.JWT_SECRET ||
    'vonos-dev-invoice-share'
  );
}

/** Signed hex token for HQ6-style public invoice URLs (`/invoice/:token`). */
export function encodePublicInvoiceToken(saleId: string): string {
  const sig = createHmac('sha256', shareSecret())
    .update(saleId)
    .digest('hex')
    .slice(0, 8);
  return Buffer.from(`${saleId}.${sig}`, 'utf8').toString('hex');
}

export function decodePublicInvoiceToken(token: string): string | null {
  if (!token || !/^[0-9a-f]+$/i.test(token)) return null;
  try {
    const raw = Buffer.from(token, 'hex').toString('utf8');
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;
    const saleId = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    if (!saleId || !sig) return null;
    const expected = createHmac('sha256', shareSecret())
      .update(saleId)
      .digest('hex')
      .slice(0, 8);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return saleId;
  } catch {
    return null;
  }
}
