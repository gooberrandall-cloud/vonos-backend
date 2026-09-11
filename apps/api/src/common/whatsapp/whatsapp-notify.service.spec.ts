import { toWhatsAppE164 } from './whatsapp-notify.service';

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
