import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFlavorSchema } from '@potato-corner/shared';

vi.mock('./flavors.repository.js', () => ({
  flavorsRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    findByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    linkVariantFlavor: vi.fn(),
    updateVariantFlavor: vi.fn(),
    findVariantFlavorLink: vi.fn(),
    upsertBranchFlavorAvailability: vi.fn(),
    findBranchFlavorAvailability: vi.fn(),
    findLinkedVariants: vi.fn(),
    allActiveBranches: vi.fn(),
  },
}));

vi.mock('../products/products.repository.js', () => ({
  productsRepository: {
    findById: vi.fn(),
    findVariantById: vi.fn(),
  },
}));

vi.mock('../branches/branches.repository.js', () => ({
  branchesRepository: {
    listAllBranchIds: vi.fn(),
  },
}));

vi.mock('../inventory/inventory.service.js', () => ({
  inventoryService: {
    provisionIdentityAcrossBranches: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { flavorsRepository } = await import('./flavors.repository.js');
const { productsRepository } = await import('../products/products.repository.js');
const { branchesRepository } = await import('../branches/branches.repository.js');
const { inventoryService } = await import('../inventory/inventory.service.js');
const { flavorsService } = await import('./flavors.service.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');

const ACTOR = { id: 'admin-1', role: 'super_admin' };

function decimal(value: number) {
  return { toNumber: () => value };
}

function buildFlavor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'flavor-1',
    name: 'Sour Cream',
    description: null,
    colorHex: '#FFD700',
    displayOrder: 1,
    isActive: true,
    ingredientName: 'Sour Cream',
    ingredientUnit: 'grams',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    variantFlavors: [],
    branchAvailability: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(branchesRepository.listAllBranchIds).mockResolvedValue([]);
});

describe('createFlavorSchema color validation', () => {
  it('rejects a color that is not #RRGGBB', () => {
    const result = createFlavorSchema.safeParse({ name: 'Sour Cream', color_hex: 'gold' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid #RRGGBB color', () => {
    const result = createFlavorSchema.safeParse({ name: 'Sour Cream', color_hex: '#FFD700' });
    expect(result.success).toBe(true);
  });
});

describe('flavorsService.createFlavor', () => {
  it('succeeds with a valid color', async () => {
    vi.mocked(flavorsRepository.findByName).mockResolvedValue(null);
    vi.mocked(flavorsRepository.create).mockResolvedValue(buildFlavor() as never);

    const result = await flavorsService.createFlavor(
      { name: 'Sour Cream', color_hex: '#FFD700', is_active: true },
      ACTOR,
      null,
    );

    expect(result.color_hex).toBe('#FFD700');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'FLAVOR_CREATED' }));
  });
});

describe('flavorsService.createFlavor — CR-005 Sub-phase 3a Hook A', () => {
  it('provisions the ingredient identity in every existing branch', async () => {
    vi.mocked(flavorsRepository.findByName).mockResolvedValue(null);
    vi.mocked(flavorsRepository.create).mockResolvedValue(buildFlavor() as never);
    vi.mocked(branchesRepository.listAllBranchIds).mockResolvedValue(['branch-1', 'branch-2', 'branch-3']);

    await flavorsService.createFlavor({ name: 'Sour Cream', color_hex: '#FFD700', is_active: true }, ACTOR, null);

    expect(inventoryService.provisionIdentityAcrossBranches).toHaveBeenCalledWith(
      { name: 'Sour Cream', unit: 'grams', category: 'FLAVOR' },
      ['branch-1', 'branch-2', 'branch-3'],
    );
  });

  it('skips provisioning when no branches exist', async () => {
    vi.mocked(flavorsRepository.findByName).mockResolvedValue(null);
    vi.mocked(flavorsRepository.create).mockResolvedValue(buildFlavor() as never);
    vi.mocked(branchesRepository.listAllBranchIds).mockResolvedValue([]);

    await flavorsService.createFlavor({ name: 'Sour Cream', color_hex: '#FFD700', is_active: true }, ACTOR, null);

    expect(inventoryService.provisionIdentityAcrossBranches).not.toHaveBeenCalled();
  });

  it('provisions with category FLAVOR', async () => {
    vi.mocked(flavorsRepository.findByName).mockResolvedValue(null);
    vi.mocked(flavorsRepository.create).mockResolvedValue(buildFlavor() as never);
    vi.mocked(branchesRepository.listAllBranchIds).mockResolvedValue(['branch-1']);

    await flavorsService.createFlavor({ name: 'Sour Cream', color_hex: '#FFD700', is_active: true }, ACTOR, null);

    const identity = vi.mocked(inventoryService.provisionIdentityAcrossBranches).mock.calls[0]?.[0];
    expect(identity?.category).toBe('FLAVOR');
  });

  it('passes the created flavor\'s ingredientName/ingredientUnit as the identity (Phase 2 backfill defaults)', async () => {
    vi.mocked(flavorsRepository.findByName).mockResolvedValue(null);
    vi.mocked(flavorsRepository.create).mockResolvedValue(
      buildFlavor({ name: 'Truffle', ingredientName: 'Truffle', ingredientUnit: 'grams' }) as never,
    );
    vi.mocked(branchesRepository.listAllBranchIds).mockResolvedValue(['branch-1']);

    await flavorsService.createFlavor({ name: 'Truffle', color_hex: '#FFD700', is_active: true }, ACTOR, null);

    const identity = vi.mocked(inventoryService.provisionIdentityAcrossBranches).mock.calls[0]?.[0];
    expect(identity).toMatchObject({ name: 'Truffle', unit: 'grams' });
  });

  it('creates the flavor first, then provisions — not inside a shared transaction', async () => {
    vi.mocked(flavorsRepository.findByName).mockResolvedValue(null);
    vi.mocked(flavorsRepository.create).mockResolvedValue(buildFlavor() as never);
    vi.mocked(branchesRepository.listAllBranchIds).mockResolvedValue(['branch-1']);

    await flavorsService.createFlavor({ name: 'Sour Cream', color_hex: '#FFD700', is_active: true }, ACTOR, null);

    const createOrder = vi.mocked(flavorsRepository.create).mock.invocationCallOrder[0] as number;
    const provisionOrder = vi.mocked(inventoryService.provisionIdentityAcrossBranches).mock.invocationCallOrder[0] as number;
    expect(createOrder).toBeLessThan(provisionOrder);
  });
});

describe('flavorsService.updateFlavor', () => {
  it('updates color and display order', async () => {
    vi.mocked(flavorsRepository.findById).mockResolvedValue(buildFlavor() as never);
    vi.mocked(flavorsRepository.update).mockResolvedValue(
      buildFlavor({ colorHex: '#00FF00', displayOrder: 5 }) as never,
    );

    const result = await flavorsService.updateFlavor('flavor-1', { color_hex: '#00FF00', display_order: 5 }, ACTOR, null);

    expect(flavorsRepository.update).toHaveBeenCalledWith(
      'flavor-1',
      expect.objectContaining({ colorHex: '#00FF00', displayOrder: 5 }),
    );
    expect(result.color_hex).toBe('#00FF00');
    expect(result.display_order).toBe(5);
  });
});

describe('flavorsService.updateFlavor — CR-005 Sub-phase 3a Hook A reactivation', () => {
  it('provisions the ingredient identity on false→true is_active transition', async () => {
    vi.mocked(flavorsRepository.findById).mockResolvedValue(buildFlavor({ isActive: false }) as never);
    vi.mocked(flavorsRepository.update).mockResolvedValue(buildFlavor({ isActive: true }) as never);
    vi.mocked(branchesRepository.listAllBranchIds).mockResolvedValue(['branch-1', 'branch-2']);

    await flavorsService.updateFlavor('flavor-1', { is_active: true }, ACTOR, null);

    expect(inventoryService.provisionIdentityAcrossBranches).toHaveBeenCalledWith(
      { name: 'Sour Cream', unit: 'grams', category: 'FLAVOR' },
      ['branch-1', 'branch-2'],
    );
  });

  it('does not provision on true→false (deactivation)', async () => {
    vi.mocked(flavorsRepository.findById).mockResolvedValue(buildFlavor({ isActive: true }) as never);
    vi.mocked(flavorsRepository.update).mockResolvedValue(buildFlavor({ isActive: false }) as never);

    await flavorsService.updateFlavor('flavor-1', { is_active: false }, ACTOR, null);

    expect(inventoryService.provisionIdentityAcrossBranches).not.toHaveBeenCalled();
  });

  it('does not provision on a same-state update (true→true)', async () => {
    vi.mocked(flavorsRepository.findById).mockResolvedValue(buildFlavor({ isActive: true }) as never);
    vi.mocked(flavorsRepository.update).mockResolvedValue(buildFlavor({ isActive: true, displayOrder: 9 }) as never);

    await flavorsService.updateFlavor('flavor-1', { display_order: 9 }, ACTOR, null);

    expect(inventoryService.provisionIdentityAcrossBranches).not.toHaveBeenCalled();
  });

  it('does not provision on a same-state update (false→false)', async () => {
    vi.mocked(flavorsRepository.findById).mockResolvedValue(buildFlavor({ isActive: false }) as never);
    vi.mocked(flavorsRepository.update).mockResolvedValue(buildFlavor({ isActive: false, displayOrder: 9 }) as never);

    await flavorsService.updateFlavor('flavor-1', { display_order: 9 }, ACTOR, null);

    expect(inventoryService.provisionIdentityAcrossBranches).not.toHaveBeenCalled();
  });

  it('rejects an attempted update of ingredient_name with FLAVOR_IDENTITY_IMMUTABLE', async () => {
    await expect(
      flavorsService.updateFlavor('flavor-1', { ingredient_name: 'Something Else' } as never, ACTOR, null),
    ).rejects.toMatchObject({ code: 'FLAVOR_IDENTITY_IMMUTABLE', statusCode: 400 });

    expect(flavorsRepository.findById).not.toHaveBeenCalled();
    expect(flavorsRepository.update).not.toHaveBeenCalled();
  });

  it('rejects an attempted update of ingredient_unit with FLAVOR_IDENTITY_IMMUTABLE', async () => {
    await expect(
      flavorsService.updateFlavor('flavor-1', { ingredient_unit: 'kg' } as never, ACTOR, null),
    ).rejects.toMatchObject({ code: 'FLAVOR_IDENTITY_IMMUTABLE', statusCode: 400 });

    expect(flavorsRepository.findById).not.toHaveBeenCalled();
    expect(flavorsRepository.update).not.toHaveBeenCalled();
  });
});

describe('flavorsService.linkFlavorToVariant', () => {
  it('prevents linking a flavor that is already linked to the variant', async () => {
    vi.mocked(productsRepository.findById).mockResolvedValue({ id: 'prod-1' } as never);
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1', productId: 'prod-1' } as never);
    vi.mocked(flavorsRepository.findById).mockResolvedValue(buildFlavor() as never);
    vi.mocked(flavorsRepository.findVariantFlavorLink).mockResolvedValue({
      productVariantId: 'variant-1',
      flavorId: 'flavor-1',
    } as never);

    await expect(
      flavorsService.linkFlavorToVariant(
        'prod-1',
        'variant-1',
        { flavor_id: 'flavor-1', price_premium: 5, is_available: true },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'VARIANT_FLAVOR_ALREADY_LINKED', statusCode: 409 });

    expect(flavorsRepository.linkVariantFlavor).not.toHaveBeenCalled();
  });
});

describe('flavorsService.updateVariantFlavor', () => {
  it('updates the price premium', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1', productId: 'prod-1' } as never);
    vi.mocked(flavorsRepository.findVariantFlavorLink).mockResolvedValue({
      productVariantId: 'variant-1',
      flavorId: 'flavor-1',
      pricePremium: decimal(5),
      isAvailable: true,
    } as never);
    vi.mocked(flavorsRepository.updateVariantFlavor).mockResolvedValue({
      flavorId: 'flavor-1',
      pricePremium: decimal(10),
      isAvailable: true,
      flavor: { name: 'Sour Cream', colorHex: '#FFD700' },
    } as never);

    const result = await flavorsService.updateVariantFlavor('prod-1', 'variant-1', 'flavor-1', { price_premium: 10 }, ACTOR, null);

    expect(flavorsRepository.updateVariantFlavor).toHaveBeenCalledWith('variant-1', 'flavor-1', {
      pricePremium: 10,
      isAvailable: undefined,
    });
    expect(result.price_premium).toBe(10);
  });
});

describe('flavorsService.updateBranchFlavorAvailability', () => {
  it('stores unavailable_reason when setting unavailable', async () => {
    vi.mocked(flavorsRepository.findById).mockResolvedValue(buildFlavor() as never);
    vi.mocked(flavorsRepository.upsertBranchFlavorAvailability).mockResolvedValue({
      id: 'row-1',
      branchId: 'branch-a',
      isAvailable: false,
      unavailableReason: 'Out of stock',
      updatedAt: new Date(),
      branch: { code: 'PC-MNL-001', name: 'Main', city: 'Manila' },
    } as never);

    const result = await flavorsService.updateBranchFlavorAvailability('flavor-1', 'branch-a', false, 'Out of stock', ACTOR, null);

    expect(flavorsRepository.upsertBranchFlavorAvailability).toHaveBeenCalledWith('branch-a', 'flavor-1', false, 'Out of stock');
    expect(result.unavailable_reason).toBe('Out of stock');
  });

  it('clears unavailable_reason when setting available', async () => {
    vi.mocked(flavorsRepository.findById).mockResolvedValue(buildFlavor() as never);
    vi.mocked(flavorsRepository.upsertBranchFlavorAvailability).mockResolvedValue({
      id: 'row-1',
      branchId: 'branch-a',
      isAvailable: true,
      unavailableReason: null,
      updatedAt: new Date(),
      branch: { code: 'PC-MNL-001', name: 'Main', city: 'Manila' },
    } as never);

    const result = await flavorsService.updateBranchFlavorAvailability('flavor-1', 'branch-a', true, undefined, ACTOR, null);

    expect(result.unavailable_reason).toBeNull();
  });
});
