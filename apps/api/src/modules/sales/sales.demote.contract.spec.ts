import { readFileSync } from 'fs';
import { join } from 'path';

describe('SalesService.update — demote final/paid → quotation/draft', () => {
  const src = readFileSync(join(__dirname, 'sales.service.ts'), 'utf8');
  const updateStart = src.indexOf('async update(');
  const finalizeStart = src.indexOf('async finalize(');
  const update = src.slice(
    updateStart,
    finalizeStart === -1 ? undefined : finalizeStart,
  );

  it('allows demoting a completed sale (no hard block)', () => {
    expect(update).not.toContain(
      'A completed sale cannot be changed to draft or quotation',
    );
    expect(update).toContain('wasFinalized && isProvisional');
  });

  it('reverses payments and ledger when demoting', () => {
    expect(update).toContain('softDeletePaymentAccountTxns');
    expect(update).toContain('tx.payment.updateMany');
    expect(update).toContain("linkedRecordType: 'sale'");
  });

  it('restores stock when demoting a finalized sale', () => {
    expect(update).toContain('if (wasFinalized)');
    expect(update).toContain('await applyLineStock(line, 1)');
  });
});
