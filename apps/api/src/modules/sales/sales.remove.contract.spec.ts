import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('SalesService.remove (audit: delete must not crash / hard-delete)', () => {
  const src = readFileSync(join(__dirname, 'sales.service.ts'), 'utf8');
  const removeStart = src.indexOf('async remove(id: string)');
  const nextMethod = src.indexOf('\n  async ', removeStart + 10);
  const remove = src.slice(removeStart, nextMethod === -1 ? undefined : nextMethod);

  it('soft-deletes the sale and related payments / ledger / invoices', () => {
    expect(remove).toContain('deletedAt: new Date()');
    expect(remove).toContain('softDeletePaymentAccountTxns');
    expect(remove).toContain("linkedRecordType: 'sale'");
    expect(remove).toContain('tx.invoice.updateMany');
    expect(remove).toContain('tx.payment.updateMany');
  });

  it('restores stock for finalized sales', () => {
    expect(remove).toContain('wasFinalized');
    expect(remove).toContain('adjustItemLocationStock');
    expect(remove).toContain('delta: qty');
  });

  it('soft-deletes linked sale outbound stock movements', () => {
    expect(remove).toContain('softDeleteSaleOutboundMovements');
  });

  it('does not call prisma sale.delete (hard delete)', () => {
    expect(remove).not.toMatch(/tx\.sale\.delete\(/);
    expect(remove).not.toMatch(/this\.tenantDb\.db\.sale\.delete\(/);
  });
});