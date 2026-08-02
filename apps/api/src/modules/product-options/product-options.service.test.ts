import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./product-options.repository.js', () => ({
  productOptionsRepository: {
    findAllGroups: vi.fn(),
    findGroupById: vi.fn(),
    findGroupByCode: vi.fn(),
    createGroup: vi.fn(),
    updateGroup: vi.fn(),
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

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { productOptionsRepository: repo } = await import('./product-options.repository.js');
const { productsRepository } = await import('../products/products.repository.js');
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
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
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
