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

const { productCategoriesRepository: repo } = await import('./product-categories.repository.js');
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

  it('POS-PERF-P35: rejects editing a category the actor did not create', async () => {
    vi.mocked(repo.findById).mockResolvedValue(buildCategory({ createdBy: 'someone-else' }) as never);

    await expect(productCategoriesService.updateCategory('cat-1', { name: 'X' }, ACTOR, null)).rejects.toMatchObject({
      code: 'CATEGORY_UPDATE_FORBIDDEN',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('POS-PERF-P35: rejects editing a shared/historical category (createdBy null)', async () => {
    vi.mocked(repo.findById).mockResolvedValue(buildCategory({ createdBy: null }) as never);

    await expect(productCategoriesService.updateCategory('cat-1', { name: 'X' }, ACTOR, null)).rejects.toMatchObject({
      code: 'CATEGORY_UPDATE_FORBIDDEN',
    });
  });

  it('POS-PERF-P35: allows editing a category the actor created', async () => {
    vi.mocked(repo.findById).mockResolvedValue(buildCategory({ createdBy: ACTOR.id }) as never);
    vi.mocked(repo.update).mockResolvedValue(buildCategory({ createdBy: ACTOR.id, name: 'X' }) as never);

    const result = await productCategoriesService.updateCategory('cat-1', { name: 'X' }, ACTOR, null);

    expect(result.name).toBe('X');
    expect(repo.update).toHaveBeenCalled();
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
