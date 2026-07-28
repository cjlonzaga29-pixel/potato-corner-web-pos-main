import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./product-components.repository.js', () => ({
  productComponentsRepository: {
    findByVariant: vi.fn(),
    findById: vi.fn(),
    findByVariantAndItem: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../universal-inventory/universal-inventory.repository.js', () => ({
  universalInventoryRepository: {
    findItemById: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { productComponentsRepository: repo } = await import('./product-components.repository.js');
const { universalInventoryRepository } = await import('../universal-inventory/universal-inventory.repository.js');
const { productComponentsService } = await import('./product-components.service.js');

const ACTOR = { id: 'admin-1', role: 'super_admin' };

function decimal(value: number) {
  return { toNumber: () => value };
}

function buildComponent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'component-1',
    productVariantId: 'variant-1',
    inventoryItemId: 'item-1',
    quantityRequired: decimal(2),
    version: 1,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    inventoryItem: { id: 'item-1', name: 'Cheese Powder', sku: null, baseUnit: { code: 'kg' } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('productComponentsService.createMapping', () => {
  it('rejects a duplicate (variant, inventory item) mapping', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(buildComponent() as never);

    await expect(
      productComponentsService.createMapping({ productVariantId: 'variant-1', inventoryItemId: 'item-1', quantityRequired: 1 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'MAPPING_ALREADY_EXISTS' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects a mapping against a non-existent inventory item', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue(null);

    await expect(
      productComponentsService.createMapping({ productVariantId: 'variant-1', inventoryItemId: 'missing', quantityRequired: 1 }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'INVENTORY_ITEM_NOT_FOUND' });
  });

  it('creates the mapping when the item exists and no duplicate is present', async () => {
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue({ id: 'item-1' } as never);
    vi.mocked(repo.findByVariantAndItem).mockResolvedValue(null);
    vi.mocked(repo.create).mockResolvedValue(buildComponent() as never);

    const result = await productComponentsService.createMapping(
      { productVariantId: 'variant-1', inventoryItemId: 'item-1', quantityRequired: 2 },
      ACTOR,
      null,
    );

    expect(result.id).toBe('component-1');
    expect(result.quantity_required).toBe(2);
  });
});
