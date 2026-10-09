/**
 * Smoke-test Unipile WhatsApp send (status notify path).
 *
 * Setup (apps/api/.env):
 *   UNIPILE_DSN=https://apiX.unipile.com:PORT   # from Unipile dashboard
 *   UNIPILE_API_KEY=...
 *   UNIPILE_WHATSAPP_ACCOUNT_ID=...             # connected WhatsApp account
 *
 * Connect WhatsApp in Unipile dashboard (QR / pairing), then:
 *   cd apps/api && npx tsx prisma/scripts/test-unipile-whatsapp.ts 08031234567
 *
 * Docs: https://developer.unipile.com/docs/send-messages
 *       https://developer.unipile.com/docs/whatsapp
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WhatsAppNotifyService } from '../../src/common/whatsapp/whatsapp-notify.service';

function loadDotEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    if (process.env[key]) continue;
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(resolve(__dirname, '../../.env'));
loadDotEnv(resolve(__dirname, '../../.env.local'));

async function main(): Promise<void> {
  const phone = process.argv[2]?.trim();
  if (!phone) {
    console.error(
      'Usage: npx tsx prisma/scripts/test-unipile-whatsapp.ts <phone>\n' +
        'Example: npx tsx prisma/scripts/test-unipile-whatsapp.ts 08031234567',
    );
    process.exit(1);
  }

  const wa = new WhatsAppNotifyService();
  console.log('configuredChannel:', wa.configuredChannel());
  console.log('unipileConfigured:', wa.isUnipileConfigured());
  console.log('metaConfigured:', wa.isCloudApiConfigured());

  if (!wa.isUnipileConfigured()) {
    console.error(
      'Missing Unipile env. Set UNIPILE_DSN, UNIPILE_API_KEY, UNIPILE_WHATSAPP_ACCOUNT_ID in apps/api/.env',
    );
    process.exit(1);
  }

  const trackUrl = wa.publicJobTrackUrl('test-token-not-real');
  const message = wa.composeStatusMessage({
    ownerName: 'Test Owner',
    plate: 'TEST-001',
    statusLabel: 'In Progress',
    trackUrl,
    shopName: 'Vonos Mechanic',
  });

  console.log('Sending to', phone);
  console.log('--- message ---');
  console.log(message);
  console.log('---------------');

  const result = await wa.notifyCustomer({ phone, message });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.sent ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
