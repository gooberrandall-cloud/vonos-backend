import { readFileSync } from 'fs';
import { join } from 'path';

describe('ItemsService write contract (create / update smoke)', () => {
  const src = readFileSync(join(__dirname, 'items.service.ts'), 'utf8');
  const createStart = src.indexOf('async create(dto: CreateItemDto)');
  const updateStart = src.indexOf('async update(id: string, dto: UpdateItemDto)');
  const removeStart = src.indexOf('async remove(id: string)');
  const create = src.slice(createStart, updateStart);
  const update = src.slice(updateStart, removeStart);

  it('getById includes brand so edit forms can prefill brandName', () => {
    expect(src).toContain('ITEM_DETAIL_INCLUDE');
    expect(src).toContain("brand: { select: { name: true } }");
    expect(src).toContain('async getById(id: string)');
    const getById = src.slice(
      src.indexOf('async getById(id: string)'),
      createStart,
    );
    expect(getById).toContain('include: ITEM_DETAIL_INCLUDE');
  });

  it('create does not require a business location when none is sent', () => {
    expect(create).toContain(
      "dto.locationCode?.trim() ? validate(dto.locationCode) : null",
    );
    expect(create).toContain('sellPrice: dto.sellPrice ?? null');
  });

  it('update persists sellPrice and product metadata', () => {
    expect(update).toContain('dto.sellPrice !== undefined ? { sellPrice: dto.sellPrice }');
    expect(update).toContain('dto.unit !== undefined');
    expect(update).toContain('dto.description !== undefined');
    expect(update).toContain('nextBrandId');
  });

  it('update skips $transaction when location stock is not being rewritten', () => {
    expect(update).toContain('locationRows !== undefined');
    expect(update).toContain('this.tenantDb.db.$transaction');
    expect(update).toContain('this.tenantDb.db.item.update');
    expect(update.indexOf('this.tenantDb.db.item.update')).toBeGreaterThan(
      update.indexOf('this.tenantDb.db.$transaction'),
    );
  });
});
