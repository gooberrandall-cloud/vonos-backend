import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('StockMovementsService VA/VP catalog-only purchases', () => {
  const src = readFileSync(join(__dirname, 'stock-movements.service.ts'), 'utf8');

  it('skips inbound stock on create for group stock consumer tenants', () => {
    expect(src).toContain('isCatalogOnlyStockTenant');
    expect(src).toContain('isGroupStockConsumerTenant');
    expect(src).toMatch(
      /!catalogOnly[\s\S]*shouldApplyInboundQty[\s\S]*applyInboundStockDeltas/,
    );
  });

  it('skips inbound receipt deltas on update for catalog-only tenants', () => {
    expect(src).toMatch(
      /const stockDeltas[\s\S]*!catalogOnly[\s\S]*inboundReceiptStockDelta/,
    );
  });

  it('skips status-change stock loop for catalog-only tenants', () => {
    expect(src).toMatch(
      /if \(!catalogOnly\) \{[\s\S]*for \(const line of lines\)/,
    );
  });
});
