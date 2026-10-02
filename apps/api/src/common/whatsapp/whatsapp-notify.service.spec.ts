import { describe, expect, it } from 'vitest';
import {
  phoneNewlySet,
  toUnipileWhatsAppAttendeeId,
  toWhatsAppE164,
} from './whatsapp-notify.service';

describe('toWhatsAppE164', () => {
  it('normalizes NG local mobiles', () => {
    expect(toWhatsAppE164('08031234567')).toBe('2348031234567');
    expect(toWhatsAppE164('+234 803 123 4567')).toBe('2348031234567');
    expect(toWhatsAppE164('8031234567')).toBe('2348031234567');
  });

  it('rejects empty / short', () => {
    expect(toWhatsAppE164('')).toBeNull();
    expect(toWhatsAppE164('123')).toBeNull();
  });
});

describe('toUnipileWhatsAppAttendeeId', () => {
  it('builds WhatsApp public attendee ids', () => {
    expect(toUnipileWhatsAppAttendeeId('2348031234567')).toBe(
      '2348031234567@s.whatsapp.net',
    );
  });
});

describe('phoneNewlySet', () => {
  it('returns e164 when phone is new', () => {
    expect(phoneNewlySet(null, '08031234567')).toBe('2348031234567');
    expect(phoneNewlySet('', '08031234567')).toBe('2348031234567');
  });

  it('returns e164 when phone changes', () => {
    expect(phoneNewlySet('08031111111', '08031234567')).toBe('2348031234567');
  });

  it('skips same number under different formatting', () => {
    expect(phoneNewlySet('08031234567', '+234 803 123 4567')).toBeNull();
    expect(phoneNewlySet('2348031234567', '08031234567')).toBeNull();
  });

  it('skips empty next', () => {
    expect(phoneNewlySet('08031234567', '')).toBeNull();
    expect(phoneNewlySet(null, null)).toBeNull();
  });
});
