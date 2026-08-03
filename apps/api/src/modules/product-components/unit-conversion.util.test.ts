import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../universal-inventory/universal-inventory.repository.js', () => ({
  universalInventoryRepository: {
    findConversion: vi.fn(),
    findItemConversion: vi.fn(),
  },
}));

const { universalInventoryRepository: repo } = await import('../universal-inventory/universal-inventory.repository.js');
const { convertQuantity, UnitConversionError } = await import('./unit-conversion.util.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(repo.findConversion).mockResolvedValue(null);
  vi.mocked(repo.findItemConversion).mockResolvedValue(null);
});

describe('convertQuantity — TASK 115 resolution priority', () => {
  it('same unit ID returns identity without querying any conversion table', async () => {
    const result = await convertQuantity(5, 'unit-g', 'unit-g');

    expect(result.toNumber()).toBe(5);
    expect(repo.findConversion).not.toHaveBeenCalled();
    expect(repo.findItemConversion).not.toHaveBeenCalled();
  });

  it('an item-specific conversion overrides the global conversion for the same unit pair', async () => {
    vi.mocked(repo.findItemConversion).mockImplementation(
      (inventoryItemId: string, fromUnitId: string, toUnitId: string) =>
        Promise.resolve(
          inventoryItemId === 'item-cheese' && fromUnitId === 'unit-tbsp' && toUnitId === 'unit-g' ? { factor: new Prisma.Decimal(7) } : null,
        ) as never,
    );
    vi.mocked(repo.findConversion).mockResolvedValue({ factor: new Prisma.Decimal(5) } as never);

    const result = await convertQuantity(2, 'unit-tbsp', 'unit-g', 'item-cheese');

    expect(result.toNumber()).toBe(14); // 2 * 7 (item-specific), not 2 * 5 (global)
    expect(repo.findItemConversion).toHaveBeenCalledWith('item-cheese', 'unit-tbsp', 'unit-g');
    expect(repo.findConversion).not.toHaveBeenCalled();
  });

  it('different items resolve different factors for the identical unit pair', async () => {
    vi.mocked(repo.findItemConversion).mockImplementation(
      (inventoryItemId: string) =>
        Promise.resolve(
          inventoryItemId === 'item-cheese'
            ? { factor: new Prisma.Decimal(7) }
            : inventoryItemId === 'item-bbq'
              ? { factor: new Prisma.Decimal(6) }
              : null,
        ) as never,
    );

    const cheese = await convertQuantity(1, 'unit-tbsp', 'unit-g', 'item-cheese');
    const bbq = await convertQuantity(1, 'unit-tbsp', 'unit-g', 'item-bbq');

    expect(cheese.toNumber()).toBe(7);
    expect(bbq.toNumber()).toBe(6);
  });

  it('falls back to the global UnitConversion when no item-specific row exists', async () => {
    vi.mocked(repo.findItemConversion).mockResolvedValue(null);
    vi.mocked(repo.findConversion).mockResolvedValue({ factor: new Prisma.Decimal(1000) } as never);

    const result = await convertQuantity(3, 'unit-kg', 'unit-g', 'item-1');

    expect(result.toNumber()).toBe(3000);
  });

  it('falls back to the global UnitConversion when no inventoryItemId is given at all', async () => {
    vi.mocked(repo.findConversion).mockResolvedValue({ factor: new Prisma.Decimal(1000) } as never);

    const result = await convertQuantity(3, 'unit-kg', 'unit-g');

    expect(result.toNumber()).toBe(3000);
    expect(repo.findItemConversion).not.toHaveBeenCalled();
  });

  it('uses the inverse global conversion when only the reverse direction is defined', async () => {
    vi.mocked(repo.findConversion).mockImplementation(
      (fromUnitId: string, toUnitId: string) => Promise.resolve(fromUnitId === 'unit-g' && toUnitId === 'unit-kg' ? { factor: new Prisma.Decimal(1000) } : null) as never,
    );

    const result = await convertQuantity(2000, 'unit-kg', 'unit-g');

    expect(result.toNumber()).toBe(2);
  });

  it('fails closed with UnitConversionError when neither an item-specific nor a global conversion exists', async () => {
    await expect(convertQuantity(1, 'unit-tbsp', 'unit-g', 'item-1')).rejects.toBeInstanceOf(UnitConversionError);
  });
});
