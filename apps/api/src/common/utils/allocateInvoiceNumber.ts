/**
 * Allocate the next sale invoice number from the tenant's invoice scheme.
 * Year schemes format as `{year}/{padded}` (e.g. 2026/0001) — Ultimate POS style
 * with a slash separator.
 */

type SchemeRow = {
  id: string;
  prefix: string | null;
  startNumber: number;
  invoiceCount: number;
  totalDigits: number;
};

type InvoiceSchemeDb = {
  invoiceScheme: {
    findFirst: (args: {
      where: Record<string, unknown>;
    }) => Promise<SchemeRow | null>;
    create: (args: {
      data: {
        tenantId: string;
        name: string;
        prefix: string;
        startNumber: number;
        invoiceCount: number;
        totalDigits: number;
        isDefault: boolean;
      };
    }) => Promise<SchemeRow>;
    update: (args: {
      where: { id: string };
      data: { invoiceCount: { increment: number } };
    }) => Promise<SchemeRow>;
  };
};

/** Prefix is a year format when it is only YYYY, YYYY/, or YYYY-. */
export function isYearInvoicePrefix(prefix: string | null | undefined): boolean {
  const p = (prefix ?? '').trim();
  return /^\d{4}[/\\-]?$/.test(p);
}

/** Tenant-code style prefixes (VA, VP, VISP…) — migrate to year/number. */
export function isTenantCodeInvoicePrefix(
  prefix: string | null | undefined,
): boolean {
  const p = (prefix ?? '').trim();
  return /^[A-Za-z]{1,6}$/.test(p);
}

/**
 * Resolve the printable prefix. Year / blank / tenant-code prefixes become
 * `{currentYear}/` (e.g. 2026/). Other custom prefixes are kept as stored.
 */
export function resolveInvoicePrefix(stored: string | null | undefined): string {
  const p = (stored ?? '').trim();
  if (!p || isYearInvoicePrefix(p) || isTenantCodeInvoicePrefix(p)) {
    return `${new Date().getFullYear()}/`;
  }
  return p;
}

export function formatInvoiceNumber(
  prefix: string | null | undefined,
  sequence: number,
  totalDigits: number,
): string {
  const digits = Math.max(1, Math.min(10, totalDigits || 4));
  const padded = String(Math.max(0, sequence)).padStart(digits, '0');
  return `${resolveInvoicePrefix(prefix)}${padded}`;
}

export function defaultYearInvoicePrefix(at = new Date()): string {
  return `${at.getFullYear()}/`;
}

/**
 * Atomically increments invoiceCount on the default (or named) scheme and
 * returns the formatted number (startNumber + count − 1, zero-padded).
 */
export async function allocateNextInvoiceNumber(
  db: InvoiceSchemeDb,
  tenantId: string,
  opts?: { schemeId?: string },
): Promise<string> {
  let scheme = await db.invoiceScheme.findFirst({
    where: {
      tenantId,
      deletedAt: null,
      ...(opts?.schemeId
        ? { id: opts.schemeId }
        : { isDefault: true }),
    },
  });

  if (!scheme && !opts?.schemeId) {
    scheme = await db.invoiceScheme.findFirst({
      where: { tenantId, deletedAt: null },
    });
  }

  if (!scheme) {
    scheme = await db.invoiceScheme.create({
      data: {
        tenantId,
        name: 'Default',
        prefix: defaultYearInvoicePrefix(),
        startNumber: 1,
        invoiceCount: 0,
        totalDigits: 4,
        isDefault: true,
      },
    });
  }

  const updated = await db.invoiceScheme.update({
    where: { id: scheme.id },
    data: { invoiceCount: { increment: 1 } },
  });

  const sequence = updated.startNumber + updated.invoiceCount - 1;
  return formatInvoiceNumber(
    updated.prefix,
    sequence,
    updated.totalDigits,
  );
}
