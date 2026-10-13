import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./product-options.repository.js', () => ({
  productOptionsRepository: {
    findAllGroups: vi.fn(),
    findGroupById: vi.fn(),
    findGroupByCode: vi.fn(),
    createGroup: vi.fn(),
    updateGroup: vi.fn(),
    countVariantAssignments: vi.fn(),
    findAssignedProductOwnership: vi.fn(),
    countOptionReferences: vi.fn(),
    deleteGroup: vi.fn(),
    findOptionById: vi.fn(),
    findOptionByCode: vi.fn(),
    createOption: vi.fn(),
    updateOption: vi.fn(),
    findVariantOptionGroups: vi.fn(),
    findVariantOptionGroupAssignment: vi.fn(),
    findVariantOptionGroupById: vi.fn(),
    assignOptionGroup: vi.fn(),
    updateVariantOptionGroup: vi.fn(),
    deleteVariantOptionGroup: vi.fn(),
    findAssignedVariantsForOption: vi.fn(),
  },
}));

vi.mock('../products/products.repository.js', () => ({
  productsRepository: {
    findVariantById: vi.fn(),
  },
}));

vi.mock('../universal-inventory/universal-inventory.repository.js', () => ({
  universalInventoryRepository: {
    findItemById: vi.fn(),
    findUnitById: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// POS-PERF-P36 — catalog-authority.ts's hasSharedCatalogAuthority (option
// groups/options) and hasActiveCatalogAuthorityForProduct (variant
// assignment) both read this. Option groups/options are branch-agnostic
// shared master data — authority = "actor has >=1 active branch
// assignment", never per-group/per-option createdBy/managedBy anymore.
vi.mock('../branches/branches.repository.js', () => ({
  branchesRepository: {
    findAllActiveBranchIds: vi.fn(),
  },
}));

const { productOptionsRepository: repo } = await import('./product-options.repository.js');
const { productsRepository } = await import('../products/products.repository.js');
const { universalInventoryRepository } = await import('../universal-inventory/universal-inventory.repository.js');
const { branchesRepository } = await import('../branches/branches.repository.js');
const { productOptionsService } = await import('./product-options.service.js');

const ACTOR = { id: 'admin-1', role: 'super_admin' };

function decimal(value: number) {
  return { toNumber: () => value };
}

function buildGroup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'group-1',
    code: 'flavor',
    name: 'Flavor',
    description: null,
    posButtonLabel: null,
    selectionType: 'SINGLE',
    minSelections: 1,
    maxSelections: 1,
    required: true,
    isActive: true,
    sortOrder: 1,
    // POS-PERF-P35 — defaults to the fixture actor's own group; tests for
    // the ownership-denial path override this explicitly.
    createdBy: ACTOR.id,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    options: [],
    _count: { options: 0 },
    ...overrides,
  };
}

function buildOption(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'option-1',
    optionGroupId: 'group-1',
    code: 'cheese',
    name: 'Cheese',
    priceAdjustment: decimal(0),
    imageUrl: null,
    isActive: true,
    sortOrder: 1,
    // POS-PERF-P35 — see buildGroup's createdBy note.
    createdBy: ACTOR.id,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function buildItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'item-1',
    name: 'Cheese Powder',
    baseUnitId: 'unit-g',
    category: { id: 'cat-1', name: 'Toppings' },
    baseUnit: { id: 'unit-g', code: 'g', name: 'Gram' },
    ...overrides,
  };
}

function buildUnit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'unit-g',
    code: 'g',
    name: 'Gram',
    dimension: 'WEIGHT',
    isBaseUnit: true,
    isActive: true,
    ...overrides,
  };
}

function buildMapping(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    quantityRequired: decimal(10),
    deductionUnit: { id: 'unit-g', code: 'g', name: 'Gram' },
    inventoryItem: {
      id: 'item-1',
      name: 'Cheese Powder',
      category: { id: 'cat-1', name: 'Toppings' },
      baseUnit: { id: 'unit-g', code: 'g', name: 'Gram' },
    },
    ...overrides,
  };
}

function buildAssignment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'assign-1',
    productVariantId: 'variant-1',
    optionGroupId: 'group-1',
    required: null,
    sortOrder: 0,
    optionGroup: { code: 'flavor', name: 'Flavor', selectionType: 'SINGLE', minSelections: 1, maxSelections: 1, required: true },
    allowedOptions: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
});

describe('productOptionsService.createGroup', () => {
  it('rejects a duplicate option group code', async () => {
    vi.mocked(repo.findGroupByCode).mockResolvedValue(buildGroup() as never);

    await expect(
      productOptionsService.createGroup(
        { code: 'flavor', name: 'Flavor', selection_type: 'SINGLE', min_selections: 0, required: false, is_active: true },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'OPTION_GROUP_CODE_CONFLICT' });
    expect(repo.createGroup).not.toHaveBeenCalled();
  });
});

describe('productOptionsService.updateGroup', () => {
  it('404s when the group does not exist', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(null);

    await expect(productOptionsService.updateGroup('missing-group', { name: 'New name' }, ACTOR, null)).rejects.toMatchObject({
      code: 'OPTION_GROUP_NOT_FOUND',
    });
  });

  it('POS-PERF-P36: allows editing a group created by another supervisor — option groups are branch-agnostic shared master data, not personally owned', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup({ createdBy: 'someone-else' }) as never);
    vi.mocked(repo.updateGroup).mockResolvedValue(buildGroup({ createdBy: 'someone-else', name: 'New name' }) as never);

    await productOptionsService.updateGroup('group-1', { name: 'New name' }, ACTOR, null);

    expect(repo.updateGroup).toHaveBeenCalled();
  });

  it('POS-PERF-P36: denies editing when the actor has zero active branch assignments', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([]);
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);

    await expect(productOptionsService.updateGroup('group-1', { name: 'New name' }, ACTOR, null)).rejects.toMatchObject({
      code: 'OPTION_GROUP_UPDATE_FORBIDDEN',
    });
    expect(repo.updateGroup).not.toHaveBeenCalled();
  });

  it('allows a cosmetic change (name) without checking variant assignments at all', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.updateGroup).mockResolvedValue(buildGroup({ name: 'Flavor (Updated)' }) as never);

    await productOptionsService.updateGroup('group-1', { name: 'Flavor (Updated)' }, ACTOR, null);

    expect(repo.findAssignedProductOwnership).not.toHaveBeenCalled();
    expect(repo.updateGroup).toHaveBeenCalled();
  });

  it('POS-PERF-P35R shared-reference protection: blocks a selection_type change when another supervisor’s product variant still has this group assigned', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.findAssignedProductOwnership).mockResolvedValue([
      { productVariant: { product: { createdBy: 'someone-else', managedBy: null } } },
    ] as never);

    await expect(
      productOptionsService.updateGroup('group-1', { selection_type: 'MULTIPLE' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'OPTION_GROUP_SEMANTIC_CHANGE_BLOCKED', statusCode: 409 });
    expect(repo.updateGroup).not.toHaveBeenCalled();
  });

  it('POS-PERF-P35R2 shared-reference protection: blocks a selection_type change when an assigned variant belongs to an unassigned/shared product (createdBy and managedBy both null)', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.findAssignedProductOwnership).mockResolvedValue([
      { productVariant: { product: { createdBy: null, managedBy: null } } },
    ] as never);

    await expect(
      productOptionsService.updateGroup('group-1', { selection_type: 'MULTIPLE' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'OPTION_GROUP_SEMANTIC_CHANGE_BLOCKED', statusCode: 409 });
    expect(repo.updateGroup).not.toHaveBeenCalled();
  });

  it('allows a selection_type change when every assigned variant belongs to a product the actor themselves manages', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.findAssignedProductOwnership).mockResolvedValue([
      { productVariant: { product: { createdBy: ACTOR.id, managedBy: null } } },
    ] as never);
    vi.mocked(repo.updateGroup).mockResolvedValue(buildGroup({ selectionType: 'MULTIPLE' }) as never);

    await productOptionsService.updateGroup('group-1', { selection_type: 'MULTIPLE' }, ACTOR, null);

    expect(repo.updateGroup).toHaveBeenCalled();
  });

  it('respects an explicit management assignment (managedBy) as the effective owner for the semantic-change check', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup({ managedBy: ACTOR.id, createdBy: 'original-creator' }) as never);
    vi.mocked(repo.findAssignedProductOwnership).mockResolvedValue([
      { productVariant: { product: { createdBy: 'original-creator', managedBy: ACTOR.id } } },
    ] as never);
    vi.mocked(repo.updateGroup).mockResolvedValue(buildGroup({ selectionType: 'MULTIPLE' }) as never);

    await productOptionsService.updateGroup('group-1', { selection_type: 'MULTIPLE' }, ACTOR, null);

    expect(repo.updateGroup).toHaveBeenCalled();
  });
});

describe('productOptionsService.deleteGroup', () => {
  it('404s when the group does not exist', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(null);

    await expect(productOptionsService.deleteGroup('missing-group', ACTOR, null)).rejects.toMatchObject({
      code: 'OPTION_GROUP_NOT_FOUND',
    });
    expect(repo.deleteGroup).not.toHaveBeenCalled();
  });

  it('409s when the group is still assigned to any product variant', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.countVariantAssignments).mockResolvedValue(3);

    await expect(productOptionsService.deleteGroup('group-1', ACTOR, null)).rejects.toMatchObject({
      code: 'OPTION_GROUP_IN_USE',
      statusCode: 409,
    });
    expect(repo.deleteGroup).not.toHaveBeenCalled();
  });

  it('409s when an option in the group is referenced by a recipe/BOM component or inventory mapping (P3D-P3)', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup({ options: [buildOption()] }) as never);
    vi.mocked(repo.countVariantAssignments).mockResolvedValue(0);
    vi.mocked(repo.countOptionReferences).mockResolvedValue(1);

    await expect(productOptionsService.deleteGroup('group-1', ACTOR, null)).rejects.toMatchObject({
      code: 'OPTION_GROUP_OPTIONS_REFERENCED',
      statusCode: 409,
    });
    expect(repo.countOptionReferences).toHaveBeenCalledWith(['option-1']);
    expect(repo.deleteGroup).not.toHaveBeenCalled();
  });

  it('deletes the group and records an audit log when it has zero variant assignments and zero option references', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.countVariantAssignments).mockResolvedValue(0);
    vi.mocked(repo.countOptionReferences).mockResolvedValue(0);
    vi.mocked(repo.deleteGroup).mockResolvedValue(undefined as never);
    const { recordAuditLog } = await import('../../middleware/audit-log.js');

    await productOptionsService.deleteGroup('group-1', ACTOR, null);

    expect(repo.deleteGroup).toHaveBeenCalledWith('group-1');
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRODUCT_OPTION_GROUP_DELETED', entityType: 'product_option_group', entityId: 'group-1' }),
    );
  });
});

describe('productOptionsService.createOption', () => {
  it('404s when the parent option group does not exist', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(null);

    await expect(
      productOptionsService.createOption('missing-group', { code: 'cheese', name: 'Cheese', price_adjustment: 0, is_active: true }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'OPTION_GROUP_NOT_FOUND' });
  });

  it('rejects a duplicate option code within the same group', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.findOptionByCode).mockResolvedValue(buildOption() as never);

    await expect(
      productOptionsService.createOption('group-1', { code: 'cheese', name: 'Cheese', price_adjustment: 0, is_active: true }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'OPTION_CODE_CONFLICT' });
    expect(repo.createOption).not.toHaveBeenCalled();
  });

  it('allows the same option code in a different group', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup({ id: 'group-2', code: 'size' }) as never);
    vi.mocked(repo.findOptionByCode).mockResolvedValue(null);
    vi.mocked(repo.createOption).mockResolvedValue(buildOption({ optionGroupId: 'group-2' }) as never);

    const result = await productOptionsService.createOption(
      'group-2',
      { code: 'cheese', name: 'Cheese', price_adjustment: 0, is_active: true },
      ACTOR,
      null,
    );
    expect(result.option_group_id).toBe('group-2');
  });
});

describe('productOptionsService.createOption — inventory_deduction (TASK 75)', () => {
  it('creates the option without a mapping when inventory_deduction is omitted', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.findOptionByCode).mockResolvedValue(null);
    vi.mocked(repo.createOption).mockResolvedValue(buildOption() as never);

    const result = await productOptionsService.createOption(
      'group-1',
      { code: 'cheese', name: 'Cheese', price_adjustment: 0, is_active: true },
      ACTOR,
      null,
    );

    expect(repo.createOption).toHaveBeenCalledWith(expect.objectContaining({ inventoryDeduction: undefined }));
    expect(result.inventory_deduction).toBeNull();
  });

  it('404s when inventory_item_id does not exist', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.findOptionByCode).mockResolvedValue(null);
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue(null);

    await expect(
      productOptionsService.createOption(
        'group-1',
        {
          code: 'cheese',
          name: 'Cheese',
          price_adjustment: 0,
          is_active: true,
          inventory_deduction: { inventory_item_id: 'missing-item', deduction_unit_id: 'unit-g', quantity_required: 10 },
        },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'INVENTORY_ITEM_NOT_FOUND' });
    expect(repo.createOption).not.toHaveBeenCalled();
  });

  it('404s when deduction_unit_id does not exist or is inactive', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.findOptionByCode).mockResolvedValue(null);
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue(buildItem() as never);
    vi.mocked(universalInventoryRepository.findUnitById).mockResolvedValue(null);

    await expect(
      productOptionsService.createOption(
        'group-1',
        {
          code: 'cheese',
          name: 'Cheese',
          price_adjustment: 0,
          is_active: true,
          inventory_deduction: { inventory_item_id: 'item-1', deduction_unit_id: 'missing-unit', quantity_required: 10 },
        },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'DEDUCTION_UNIT_NOT_FOUND' });
    expect(repo.createOption).not.toHaveBeenCalled();
  });

  it('rejects a deduction unit whose dimension does not match the item base unit', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.findOptionByCode).mockResolvedValue(null);
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue(buildItem() as never);
    vi.mocked(universalInventoryRepository.findUnitById).mockImplementation(((id: string) => {
      if (id === 'unit-ml') return Promise.resolve(buildUnit({ id: 'unit-ml', code: 'ml', dimension: 'VOLUME' }));
      if (id === 'unit-g') return Promise.resolve(buildUnit()); // base unit lookup
      return Promise.resolve(null);
    }) as never);

    await expect(
      productOptionsService.createOption(
        'group-1',
        {
          code: 'cheese',
          name: 'Cheese',
          price_adjustment: 0,
          is_active: true,
          inventory_deduction: { inventory_item_id: 'item-1', deduction_unit_id: 'unit-ml', quantity_required: 10 },
        },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'DEDUCTION_UNIT_DIMENSION_MISMATCH' });
    expect(repo.createOption).not.toHaveBeenCalled();
  });

  it('creates the mapping when the deduction unit is compatible with the item base unit', async () => {
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.findOptionByCode).mockResolvedValue(null);
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue(buildItem() as never);
    vi.mocked(universalInventoryRepository.findUnitById).mockResolvedValue(buildUnit() as never);
    vi.mocked(repo.createOption).mockResolvedValue(buildOption({ inventoryMapping: buildMapping() }) as never);

    const result = await productOptionsService.createOption(
      'group-1',
      {
        code: 'cheese',
        name: 'Cheese',
        price_adjustment: 0,
        is_active: true,
        inventory_deduction: { inventory_item_id: 'item-1', deduction_unit_id: 'unit-g', quantity_required: 10 },
      },
      ACTOR,
      null,
    );

    expect(repo.createOption).toHaveBeenCalledWith(
      expect.objectContaining({
        inventoryDeduction: { inventoryItemId: 'item-1', deductionUnitId: 'unit-g', quantityRequired: 10 },
      }),
    );
    expect(result.inventory_deduction).toMatchObject({
      inventory_item_id: 'item-1',
      inventory_category_id: 'cat-1',
      base_unit_code: 'g',
      deduction_unit_code: 'g',
      quantity_required: 10,
    });
  });
});

describe('productOptionsService.updateOption — branch-team authority (POS-PERF-P36)', () => {
  it('allows a supervisor with an active branch assignment to edit an option created/managed by a different supervisor — PRODUCT_OPTION is branch-agnostic shared master data, not personally owned', async () => {
    vi.mocked(repo.findOptionById).mockResolvedValue(buildOption({ createdBy: 'other-supervisor', managedBy: 'yet-another-supervisor', inventoryMapping: null }) as never);
    vi.mocked(repo.updateOption).mockResolvedValue(buildOption({ inventoryMapping: null }) as never);

    const result = await productOptionsService.updateOption(
      'group-1',
      'option-1',
      { name: 'Cheese v2' },
      { id: ACTOR.id, role: 'supervisor' },
      null,
    );

    expect(repo.updateOption).toHaveBeenCalled();
    expect(result.name).toBe('Cheese');
  });

  it('denies a supervisor with zero active branch assignments, regardless of who created/manages the option', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([]);
    vi.mocked(repo.findOptionById).mockResolvedValue(buildOption({ createdBy: ACTOR.id, managedBy: ACTOR.id }) as never);

    await expect(
      productOptionsService.updateOption('group-1', 'option-1', { name: 'Cheese v2' }, { id: ACTOR.id, role: 'supervisor' }, null),
    ).rejects.toMatchObject({ code: 'OPTION_UPDATE_FORBIDDEN' });
    expect(repo.updateOption).not.toHaveBeenCalled();
  });
});

describe('productOptionsService.updateOption — inventory_deduction (TASK 75)', () => {
  it('preserves the existing mapping when inventory_deduction is omitted', async () => {
    vi.mocked(repo.findOptionById).mockResolvedValue(buildOption({ inventoryMapping: buildMapping() }) as never);
    vi.mocked(repo.updateOption).mockResolvedValue(buildOption({ inventoryMapping: buildMapping() }) as never);

    await productOptionsService.updateOption('group-1', 'option-1', { name: 'Cheese v2' }, ACTOR, null);

    expect(repo.updateOption).toHaveBeenCalledWith('option-1', expect.objectContaining({ inventoryDeduction: undefined }));
  });

  it('removes the mapping when inventory_deduction is explicitly null', async () => {
    vi.mocked(repo.findOptionById).mockResolvedValue(buildOption({ inventoryMapping: buildMapping() }) as never);
    vi.mocked(repo.updateOption).mockResolvedValue(buildOption({ inventoryMapping: null }) as never);

    const result = await productOptionsService.updateOption('group-1', 'option-1', { inventory_deduction: null }, ACTOR, null);

    expect(repo.updateOption).toHaveBeenCalledWith('option-1', expect.objectContaining({ inventoryDeduction: null }));
    expect(result.inventory_deduction).toBeNull();
  });

  it('is a no-op (no delete dispatched) when removing a mapping that does not exist', async () => {
    vi.mocked(repo.findOptionById).mockResolvedValue(buildOption({ inventoryMapping: null }) as never);
    vi.mocked(repo.updateOption).mockResolvedValue(buildOption({ inventoryMapping: null }) as never);

    await productOptionsService.updateOption('group-1', 'option-1', { inventory_deduction: null }, ACTOR, null);

    expect(repo.updateOption).toHaveBeenCalledWith('option-1', expect.objectContaining({ inventoryDeduction: undefined }));
  });

  it('creates or updates the mapping when inventory_deduction is an object', async () => {
    vi.mocked(repo.findOptionById).mockResolvedValue(buildOption({ inventoryMapping: null }) as never);
    vi.mocked(universalInventoryRepository.findItemById).mockResolvedValue(buildItem() as never);
    vi.mocked(universalInventoryRepository.findUnitById).mockResolvedValue(buildUnit() as never);
    vi.mocked(repo.updateOption).mockResolvedValue(buildOption({ inventoryMapping: buildMapping() }) as never);

    const result = await productOptionsService.updateOption(
      'group-1',
      'option-1',
      { inventory_deduction: { inventory_item_id: 'item-1', deduction_unit_id: 'unit-g', quantity_required: 10 } },
      ACTOR,
      null,
    );

    expect(repo.updateOption).toHaveBeenCalledWith(
      'option-1',
      expect.objectContaining({ inventoryDeduction: { inventoryItemId: 'item-1', deductionUnitId: 'unit-g', quantityRequired: 10 } }),
    );
    expect(result.inventory_deduction).not.toBeNull();
  });
});

describe('productOptionsService.assignOptionGroupToVariant (R6)', () => {
  it('404s when the variant does not belong to the product', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1', productId: 'other-product' } as never);

    await expect(
      productOptionsService.assignOptionGroupToVariant('product-1', 'variant-1', { option_group_id: 'group-1' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'VARIANT_NOT_FOUND' });
  });

  it('rejects a duplicate assignment of the same option group to a variant', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1', productId: 'product-1' } as never);
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.findVariantOptionGroupAssignment).mockResolvedValue(buildAssignment() as never);

    await expect(
      productOptionsService.assignOptionGroupToVariant('product-1', 'variant-1', { option_group_id: 'group-1' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'VARIANT_OPTION_GROUP_ALREADY_ASSIGNED' });
    expect(repo.assignOptionGroup).not.toHaveBeenCalled();
  });

  it('rejects allowed_option_ids that do not belong to the assigned group', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1', productId: 'product-1' } as never);
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.findVariantOptionGroupAssignment).mockResolvedValue(null);
    vi.mocked(repo.findOptionById).mockResolvedValue(buildOption({ optionGroupId: 'a-different-group' }) as never);

    await expect(
      productOptionsService.assignOptionGroupToVariant(
        'product-1',
        'variant-1',
        { option_group_id: 'group-1', allowed_option_ids: ['option-1'] },
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'OPTION_NOT_IN_GROUP' });
  });

  it('assigns the group with its allowed options when everything is valid', async () => {
    vi.mocked(productsRepository.findVariantById).mockResolvedValue({ id: 'variant-1', productId: 'product-1' } as never);
    vi.mocked(repo.findGroupById).mockResolvedValue(buildGroup() as never);
    vi.mocked(repo.findVariantOptionGroupAssignment).mockResolvedValue(null);
    vi.mocked(repo.findOptionById).mockResolvedValue(buildOption() as never);
    vi.mocked(repo.assignOptionGroup).mockResolvedValue(
      buildAssignment({ allowedOptions: [{ sortOrder: 0, productOption: buildOption() }] }) as never,
    );

    const result = await productOptionsService.assignOptionGroupToVariant(
      'product-1',
      'variant-1',
      { option_group_id: 'group-1', allowed_option_ids: ['option-1'] },
      ACTOR,
      null,
    );

    expect(result.allowed_options).toHaveLength(1);
    expect(repo.assignOptionGroup).toHaveBeenCalledWith('variant-1', expect.objectContaining({ optionGroupId: 'group-1' }));
  });
});

describe('productOptionsService.getAssignedVariantsForOption (reverse lookup)', () => {
  it('404s when the option does not belong to the group', async () => {
    vi.mocked(repo.findOptionById).mockResolvedValue(buildOption({ optionGroupId: 'a-different-group' }) as never);

    await expect(productOptionsService.getAssignedVariantsForOption('group-1', 'option-1')).rejects.toMatchObject({
      code: 'OPTION_NOT_FOUND',
    });
    expect(repo.findAssignedVariantsForOption).not.toHaveBeenCalled();
  });

  it('returns the deduped list of variants that allow this option', async () => {
    vi.mocked(repo.findOptionById).mockResolvedValue(buildOption() as never);
    vi.mocked(repo.findAssignedVariantsForOption).mockResolvedValue([
      {
        variantOptionGroup: {
          productVariant: { id: 'variant-1', name: 'Regular', product: { id: 'product-1', name: 'Cheese Fries' } },
        },
      },
      {
        variantOptionGroup: {
          productVariant: { id: 'variant-1', name: 'Regular', product: { id: 'product-1', name: 'Cheese Fries' } },
        },
      },
    ] as never);

    const result = await productOptionsService.getAssignedVariantsForOption('group-1', 'option-1');

    expect(result).toEqual([
      { product_variant_id: 'variant-1', variant_name: 'Regular', product_id: 'product-1', product_name: 'Cheese Fries' },
    ]);
  });
});
