import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('./universal-inventory.repository.js', () => ({
  universalInventoryRepository: {
    findUnitByCode: vi.fn(),
    findUnitById: vi.fn(),
    findItemByName: vi.fn(),
    findItemConversion: vi.fn(),
    createItemConversion: vi.fn(),
  },
}));

const { universalInventoryRepository: repo } = await import('./universal-inventory.repository.js');
const {
  seedPotatoCornerPowderConversions,
  POTATO_CORNER_FLAVOR_POWDER_ITEM_NAMES,
  POTATO_CORNER_TBSP_TO_KG_FACTOR,
} = await import('./potato-corner-powder-conversions.seed.js');

const TBSP = { id: 'unit-tbsp', code: 'tbsp' };
const KG = { id: 'unit-kg', code: 'kg' };

function item(overrides: Partial<{ id: string; baseUnitId: string }> = {}) {
  return { id: 'item-1', baseUnitId: TBSP.id, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(repo.findUnitByCode).mockImplementation((async (code: string) => {
    if (code === 'tbsp') return TBSP;
    if (code === 'kg') return KG;
    return null;
  }) as never);
});

describe('seedPotatoCornerPowderConversions', () => {
  it('the canonical list has exactly the 10 items from the Inventory Summary screenshot', () => {
    expect(POTATO_CORNER_FLAVOR_POWDER_ITEM_NAMES).toEqual([
      'BBQ Flavor Powder',
      'Cheese Flavor Powder',
      'Chili BBQ Flavor Powder',
      'Chili Cheese Flavor Powder',
      'Golden Sweet Corn Flavor Powder',
      'Sour Cheese Flavor Powder',
      'Sour Cream Flavor Powder',
      'Sweet Corn Flavor Powder',
      'Truffle Flavor Powder',
      'White Cheddar Flavor Powder',
    ]);
    expect(POTATO_CORNER_TBSP_TO_KG_FACTOR).toBe(0.006);
  });

  it('dry run (apply=false) reports items that would be created but writes nothing', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(item() as never);
    vi.mocked(repo.findItemConversion).mockResolvedValue(null);

    const report = await seedPotatoCornerPowderConversions(false);

    expect(report.created).toHaveLength(POTATO_CORNER_FLAVOR_POWDER_ITEM_NAMES.length);
    expect(repo.createItemConversion).not.toHaveBeenCalled();
  });

  it('apply=true creates a tbsp->kg item conversion with factor 0.006 for each resolved item', async () => {
    vi.mocked(repo.findItemByName).mockImplementation((async (name: string) => item({ id: `item-${name}` })) as never);
    vi.mocked(repo.findItemConversion).mockResolvedValue(null);
    vi.mocked(repo.createItemConversion).mockResolvedValue({} as never);

    const report = await seedPotatoCornerPowderConversions(true);

    expect(repo.createItemConversion).toHaveBeenCalledTimes(POTATO_CORNER_FLAVOR_POWDER_ITEM_NAMES.length);
    expect(repo.createItemConversion).toHaveBeenCalledWith({
      inventoryItemId: 'item-BBQ Flavor Powder',
      fromUnitId: TBSP.id,
      toUnitId: KG.id,
      factor: 0.006,
    });
    expect(report.created).toHaveLength(POTATO_CORNER_FLAVOR_POWDER_ITEM_NAMES.length);
  });

  it('is idempotent: an item that already has factor 0.006 configured is reported as already-configured and not re-created', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(item({ id: 'item-bbq' }) as never);
    vi.mocked(repo.findItemConversion).mockResolvedValue({ factor: new Prisma.Decimal(0.006) } as never);

    const report = await seedPotatoCornerPowderConversions(true);

    expect(repo.createItemConversion).not.toHaveBeenCalled();
    expect(report.alreadyConfigured).toHaveLength(POTATO_CORNER_FLAVOR_POWDER_ITEM_NAMES.length);
    expect(report.created).toEqual([]);
  });

  it('never overwrites an existing conversion with a different factor — reports it as conflicting instead', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(item({ id: 'item-bbq' }) as never);
    vi.mocked(repo.findItemConversion).mockResolvedValue({ factor: new Prisma.Decimal(0.007) } as never);

    const report = await seedPotatoCornerPowderConversions(true);

    expect(repo.createItemConversion).not.toHaveBeenCalled();
    expect(report.conflicting).toEqual(
      Array(POTATO_CORNER_FLAVOR_POWDER_ITEM_NAMES.length).fill(
        expect.objectContaining({ itemId: 'item-bbq', existingFactor: '0.007' }),
      ),
    );
  });

  it('skips (never forces) an item whose base unit is not tbsp, reporting the mismatch', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(item({ id: 'item-bbq', baseUnitId: 'unit-g' }) as never);
    vi.mocked(repo.findUnitById).mockResolvedValue({ id: 'unit-g', code: 'g' } as never);

    const report = await seedPotatoCornerPowderConversions(true);

    expect(repo.createItemConversion).not.toHaveBeenCalled();
    expect(repo.findItemConversion).not.toHaveBeenCalled();
    expect(report.baseUnitMismatch[0]).toEqual({ itemName: 'BBQ Flavor Powder', itemId: 'item-bbq', baseUnitCode: 'g' });
  });

  it('reports a canonical-list name with no matching active InventoryItem as not found, without creating anything', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(null);

    const report = await seedPotatoCornerPowderConversions(true);

    expect(repo.createItemConversion).not.toHaveBeenCalled();
    expect(report.notFound).toEqual([...POTATO_CORNER_FLAVOR_POWDER_ITEM_NAMES]);
  });

  it('never creates a global UnitConversion row — only ever calls createItemConversion', async () => {
    vi.mocked(repo.findItemByName).mockResolvedValue(item() as never);
    vi.mocked(repo.findItemConversion).mockResolvedValue(null);
    vi.mocked(repo.createItemConversion).mockResolvedValue({} as never);

    await seedPotatoCornerPowderConversions(true);

    for (const call of vi.mocked(repo.createItemConversion).mock.calls) {
      expect(call[0]).toHaveProperty('inventoryItemId');
    }
  });

  it('throws (fails closed) instead of seeding anything when the tbsp or kg UnitOfMeasure is missing', async () => {
    vi.mocked(repo.findUnitByCode).mockResolvedValue(null);

    await expect(seedPotatoCornerPowderConversions(true)).rejects.toThrow();
    expect(repo.findItemByName).not.toHaveBeenCalled();
  });
});
