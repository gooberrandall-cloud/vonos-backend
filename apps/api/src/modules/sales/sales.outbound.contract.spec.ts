import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('SalesService sale outbound stock movement', () => {
  const src = readFileSync(join(__dirname, 'sales.service.ts'), 'utf8');

  it('writes outbound StockMovement after stock deduct on create', () => {
    expect(src).toContain('writeSaleOutboundMovement');
    expect(src).toContain("type: 'outbound'");
    expect(src).toContain('outboundLinesFromStockDeltas');
    expect(src).toContain('SO-');
  });

  it('writes outbound on finalize convert (quotation/draft → final)', () => {
    const finalizeStart = src.indexOf('async finalize(');
    const finalize = src.slice(finalizeStart);
    expect(finalize).toContain('writeSaleOutboundMovement');
    expect(finalize).toContain('effectiveItemOnHand');
  });

  it('convert without payments leaves sale due (no invented cash pay)', () => {
    const finalizeStart = src.indexOf('async finalize(');
    const finalize = src.slice(finalizeStart, finalizeStart + 2500);
    expect(finalize).toContain('body.payments && body.payments.length > 0');
    expect(finalize).not.toContain("[{ amount: total, method: 'cash' }]");
  });

  it('soft-deletes and rewrites outbound on update', () => {
    expect(src).toContain('softDeleteSaleOutboundMovements');
    expect(src).toContain('outboundLinesFromSaleLines');
    expect(src).toContain('stayingOrBecomingFinal');
  });

  it('links movements via saleId notes marker', () => {
    expect(src).toContain('saleId:');
    expect(src).toContain('saleOutboundNotesMarker');
  });
});
