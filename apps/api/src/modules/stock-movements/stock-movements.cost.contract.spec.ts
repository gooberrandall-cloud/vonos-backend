import { readFileSync } from 'fs';
import { join } from 'path';

// NOTE: jest globals (describe/expect/it) — the `vitest` package is not
// installed in apps/api, so contract specs here must not import it.

/**
 * Purchase cost must reach the Finance books on every receiving path, not
 * just PATCH :id/status. Regression cover for ~₦51M of received purchases
 * with stock but no cost ledger row (created/edited directly as Received).
 */
describe('StockMovementsService inbound cost booking', () => {
  const src = readFileSync(
    join(__dirname, 'stock-movements.service.ts'),
    'utf8',
  );

  it('books cost on create-as-Received via an idempotent helper', () => {
    expect(src).toContain('ensureInboundCostEntry');
    // Guard: never double-book when a cost row already exists.
    expect(src).toMatch(
      /linkedRecordType: 'stock_movement'[\s\S]*?type: 'cost'[\s\S]*?if \(existing\) return/,
    );
  });

  it('books cost on edit-form receive (PATCH :id), not only updateStatus', () => {
    expect(src).toMatch(
      /!wasReceived &&[\s\S]*?willReceive[\s\S]*?ensureInboundCostEntry/,
    );
  });

  it('feeds the daily finance rollup so Finance KPIs include the cost', () => {
    expect(src).toContain('applyDailyFinanceDelta');
  });
});
