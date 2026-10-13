import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./product-categories.repository.js', () => ({
  productCategoriesRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    findByCode: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// POS-PERF-P36 — catalog-authority.ts's hasSharedCatalogAuthority reads this
// for every category mutation check; categories are branch-agnostic shared
// master data, so authority = "actor has >=1 active branch assignment",
// never createdBy/managedBy (those stay provenance/audit only now).
vi.mock('../branches/branches.repository.js', () => ({
  branchesRepository: {
    findAllActiveBranchIds: vi.fn(),
  },
}));

const { productCategoriesRepository: repo } = await import('./product-categories.repository.js');
const { branchesRepository } = await import('../branches/branches.repository.js');
const { productCategoriesService } = await import('./product-categories.service.js');

const ACTOR = { id: 'admin-1', role: 'super_admin' };
const USER = { user_id: 'admin-1', role: 'super_admin' } as never;

function buildCategory(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cat-1',
    code: 'fries',
    name: 'Fries',
    description: null,
    isActive: true,
    sortOrder: 1,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    _count: { products: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
});

describe('productCategoriesService.createCategory', () => {
  it('rejects a duplicate code (R1 duplicate prevention)', async () => {
    vi.mocked(repo.findByCode).mockResolvedValue(buildCategory() as never);

    await expect(
      productCategoriesService.createCategory({ code: 'fries', name: 'Fries', is_active: true }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'CATEGORY_CODE_CONFLICT' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('creates a category when the code is unique', async () => {
    vi.mocked(repo.findByCode).mockResolvedValue(null);
    vi.mocked(repo.create).mockResolvedValue(buildCategory() as never);

    const result = await productCategoriesService.createCategory({ code: 'fries', name: 'Fries', is_active: true }, ACTOR, null);

    expect(result.code).toBe('fries');
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ code: 'fries', createdBy: 'admin-1' }));
  });
});

describe('productCategoriesService.updateCategory', () => {
  it('404s when the category does not exist', async () => {
    vi.mocked(repo.findById).mockResolvedValue(null);

    await expect(productCategoriesService.updateCategory('missing', { name: 'X' }, ACTOR, null)).rejects.toMatchObject({
      code: 'CATEGORY_NOT_FOUND',
    });
  });

  it('POS-PERF-P36: rejects editing when the actor has zero active branch assignments', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([]);
    vi.mocked(repo.findById).mockResolvedValue(buildCategory({ createdBy: 'someone-else' }) as never);

    await expect(productCategoriesService.updateCategory('cat-1', { name: 'X' }, ACTOR, null)).rejects.toMatchObject({
      code: 'CATEGORY_UPDATE_FORBIDDEN',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('POS-PERF-P36: allows editing a category created by another supervisor — categories are branch-agnostic shared master data, not personally owned', async () => {
    vi.mocked(repo.findById).mockResolvedValue(buildCategory({ createdBy: 'someone-else' }) as never);
    vi.mocked(repo.update).mockResolvedValue(buildCategory({ createdBy: 'someone-else', name: 'X' }) as never);

    const result = await productCategoriesService.updateCategory('cat-1', { name: 'X' }, ACTOR, null);

    expect(result.name).toBe('X');
    expect(repo.update).toHaveBeenCalled();
  });

  it('POS-PERF-P36: allows editing a shared/historical category (createdBy null) when the actor has an active branch assignment', async () => {
    vi.mocked(repo.findById).mockResolvedValue(buildCategory({ createdBy: null }) as never);
    vi.mocked(repo.update).mockResolvedValue(buildCategory({ createdBy: null, name: 'X' }) as never);

    const result = await productCategoriesService.updateCategory('cat-1', { name: 'X' }, ACTOR, null);

    expect(result.name).toBe('X');
  });
});

describe('productCategoriesService.getAllCategories', () => {
  it('returns pagination metadata alongside mapped categories', async () => {
    vi.mocked(repo.findAll).mockResolvedValue({ categories: [buildCategory()], total: 1 } as never);

    const result = await productCategoriesService.getAllCategories(USER, { page: 1, limit: 25 });

    expect(result.total).toBe(1);
    expect(result.categories[0]?.product_count).toBe(0);
  });
});
