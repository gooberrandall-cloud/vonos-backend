import { Prisma } from '@prisma/client';

/**
 * Migrated Ultimate POS data often booked the same invoice twice:
 * `Sale <ref>` (linkedRecordType=sale) and `Job <ref>` (linkedRecordType=job)
 * with the same amount and timestamp. Count sale (or non-mirrored job) once.
 *
 * Use on queries whose outer table is `"LedgerEntry"` (no alias required).
 */
export const EXCLUDE_MIRRORED_JOB_SALE_REVENUE_SQL = Prisma.sql`
  AND NOT (
    "LedgerEntry"."linkedRecordType" = 'job'
    AND EXISTS (
      SELECT 1
      FROM "LedgerEntry" s
      WHERE s."tenantId" = "LedgerEntry"."tenantId"
        AND s."deletedAt" IS NULL
        AND s.type = 'revenue'
        AND s."linkedRecordType" = 'sale'
        AND s.amount = "LedgerEntry".amount
        AND date_trunc('day', s.date AT TIME ZONE 'UTC')
          = date_trunc('day', "LedgerEntry".date AT TIME ZONE 'UTC')
        AND lower(regexp_replace(COALESCE(s.description, ''), '^sale\\s+', '', 'i'))
          = lower(regexp_replace(COALESCE("LedgerEntry".description, ''), '^job\\s+', '', 'i'))
    )
  )
`;
