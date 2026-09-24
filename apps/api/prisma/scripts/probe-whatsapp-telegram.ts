/**
 * Read-only scan: WhatsApp / Telegram sourced data in live Postgres.
 * Usage: npx tsx prisma/scripts/probe-whatsapp-telegram.ts
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';

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

const prisma = new PrismaClient();

async function main() {
  const items = await prisma.$queryRaw<
    Array<{
      tenant: string;
      active: number;
      deleted: number;
      whatsapp_images: number;
      telegram_images: number;
    }>
  >`
    SELECT
      t.code AS tenant,
      COUNT(*) FILTER (WHERE i."deletedAt" IS NULL)::int AS active,
      COUNT(*) FILTER (WHERE i."deletedAt" IS NOT NULL)::int AS deleted,
      COUNT(*) FILTER (
        WHERE i."imageUrl" ILIKE '%whatsapp%'
      )::int AS whatsapp_images,
      COUNT(*) FILTER (
        WHERE i."imageUrl" ILIKE '%telegram%'
      )::int AS telegram_images
    FROM "Item" i
    JOIN "Tenant" t ON t.id = i."tenantId"
    WHERE i."imageUrl" ILIKE '%whatsapp%'
       OR i."imageUrl" ILIKE '%telegram%'
       OR i.description ILIKE '%whatsapp%'
       OR i.description ILIKE '%telegram%'
       OR i.name ILIKE '%whatsapp%'
       OR i.name ILIKE '%telegram%'
       OR i.sku ILIKE '%whatsapp%'
       OR i.sku ILIKE '%telegram%'
    GROUP BY t.code
    ORDER BY t.code
  `;

  const itemSamples = await prisma.$queryRaw<
    Array<{
      tenant: string;
      sku: string;
      name: string;
      imageUrl: string | null;
      deleted: boolean;
    }>
  >`
    SELECT
      t.code AS tenant,
      i.sku,
      i.name,
      i."imageUrl",
      (i."deletedAt" IS NOT NULL) AS deleted
    FROM "Item" i
    JOIN "Tenant" t ON t.id = i."tenantId"
    WHERE i."imageUrl" ILIKE '%whatsapp%'
       OR i."imageUrl" ILIKE '%telegram%'
    ORDER BY t.code, i.name
    LIMIT 80
  `;

  const textHits = await prisma.$queryRaw<
    Array<{ source: string; tenant: string; hits: number }>
  >`
    SELECT 'supplier_notes' AS source, t.code AS tenant, COUNT(*)::int AS hits
    FROM "Supplier" s
    JOIN "Tenant" t ON t.id = s."tenantId"
    WHERE COALESCE(s.notes,'') ILIKE '%whatsapp%'
       OR COALESCE(s.notes,'') ILIKE '%telegram%'
       OR COALESCE(s.address,'') ILIKE '%whatsapp%'
       OR COALESCE(s.address,'') ILIKE '%telegram%'
       OR s.name ILIKE '%whatsapp%'
       OR s.name ILIKE '%telegram%'
    GROUP BY t.code
    UNION ALL
    SELECT 'customer_text', t.code, COUNT(*)::int
    FROM "Customer" c
    JOIN "Tenant" t ON t.id = c."tenantId"
    WHERE c.name ILIKE '%whatsapp%'
       OR c.name ILIKE '%telegram%'
       OR COALESCE(c."businessName",'') ILIKE '%whatsapp%'
       OR COALESCE(c."businessName",'') ILIKE '%telegram%'
       OR COALESCE(c.notes,'') ILIKE '%whatsapp%'
       OR COALESCE(c.notes,'') ILIKE '%telegram%'
       OR c.details::text ILIKE '%whatsapp%'
       OR c.details::text ILIKE '%telegram%'
    GROUP BY t.code
    UNION ALL
    SELECT 'expense', t.code, COUNT(*)::int
    FROM "Expense" e
    JOIN "Tenant" t ON t.id = e."tenantId"
    WHERE COALESCE(e.note,'') ILIKE '%whatsapp%'
       OR COALESCE(e.note,'') ILIKE '%telegram%'
       OR COALESCE(e.refNo,'') ILIKE '%whatsapp%'
       OR e.reason ILIKE '%whatsapp%'
       OR e.reason ILIKE '%telegram%'
    GROUP BY t.code
    UNION ALL
    SELECT 'ledger', t.code, COUNT(*)::int
    FROM "LedgerEntry" l
    JOIN "Tenant" t ON t.id = l."tenantId"
    WHERE l.description ILIKE '%whatsapp%'
       OR l.description ILIKE '%telegram%'
       OR l.category ILIKE '%whatsapp%'
       OR l.category ILIKE '%telegram%'
    GROUP BY t.code
    UNION ALL
    SELECT 'invoice_notes', t.code, COUNT(*)::int
    FROM "Invoice" inv
    JOIN "Tenant" t ON t.id = inv."tenantId"
    WHERE COALESCE(inv.notes,'') ILIKE '%whatsapp%'
       OR COALESCE(inv.notes,'') ILIKE '%telegram%'
    GROUP BY t.code
    UNION ALL
    SELECT 'sale_notes', t.code, COUNT(*)::int
    FROM "Sale" s
    JOIN "Tenant" t ON t.id = s."tenantId"
    WHERE COALESCE(s.notes,'') ILIKE '%whatsapp%'
       OR COALESCE(s.notes,'') ILIKE '%telegram%'
    GROUP BY t.code
    UNION ALL
    SELECT 'job', t.code, COUNT(*)::int
    FROM "Job" j
    JOIN "Tenant" t ON t.id = j."tenantId"
    WHERE j.description ILIKE '%whatsapp%'
       OR j.description ILIKE '%telegram%'
       OR COALESCE(j."quoteNotes",'') ILIKE '%whatsapp%'
       OR COALESCE(j."invoiceNotes",'') ILIKE '%whatsapp%'
       OR COALESCE(j."qcNotes",'') ILIKE '%whatsapp%'
    GROUP BY t.code
    UNION ALL
    SELECT 'notification', t.code, COUNT(*)::int
    FROM "Notification" n
    LEFT JOIN "Tenant" t ON t.id = n."tenantId"
    WHERE n.title ILIKE '%whatsapp%'
       OR n.title ILIKE '%telegram%'
       OR n.message ILIKE '%whatsapp%'
       OR n.message ILIKE '%telegram%'
    GROUP BY t.code
    ORDER BY 1, 2
  `;

  const uniqueImages = await prisma.$queryRaw<
    Array<{ imageUrl: string; products: number; tenants: number }>
  >`
    SELECT
      i."imageUrl",
      COUNT(*)::int AS products,
      COUNT(DISTINCT i."tenantId")::int AS tenants
    FROM "Item" i
    WHERE i."imageUrl" ILIKE '%whatsapp%'
       OR i."imageUrl" ILIKE '%telegram%'
    GROUP BY i."imageUrl"
    ORDER BY COUNT(*) DESC
  `;

  console.log(
    JSON.stringify(
      { items, uniqueImages, itemSamples, textHits },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
