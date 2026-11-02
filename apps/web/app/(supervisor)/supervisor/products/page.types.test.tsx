import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ProductListResponse, ProductResponse, ProductTypeResponse } from '@potato-corner/shared';

/**
 * POS-PERF-P58 — the Products page by type: the navigation and its counts, the
 * action each type offers, the URL carrying the selection, an empty view's
 * Create action, and Create Product Type staying a separate action.
 */
const MARKETING_ID = 'b6f0a7de-5b0c-4e8b-9a43-0d2b7f3f1c11';
const { mockUseProducts, mockUseProductTypes, mockPush, mockReplace, mockReset, search } = vi.hoisted(() => ({
  mockUseProducts: vi.fn(),
  mockUseProductTypes: vi.fn(),
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
  mockReset: vi.fn(),
  search: { value: '' },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush, replace: mockReplace }), useSearchParams: () => new URLSearchParams(search.value) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'sup-1', role: 'supervisor', branchIds: ['branch-a'] } }) }));
vi.mock('@/hooks/queries/use-branches', () => ({ useBranches: () => ({ data: { branches: [{ id: 'branch-a', name: 'Branch A', code: 'A' }] }, isLoading: false }) }));
vi.mock('@/hooks/use-branch', () => ({ useBranch: () => ({ activeBranchId: 'branch-a', activeBranch: { id: 'branch-a', name: 'Branch A' } }) }));
vi.mock('@/stores/product-builder.store', () => ({
  useProductBuilderStore: (select: (s: { reset: () => void; loadExisting: (id: string) => void }) => unknown) => select({ reset: mockReset, loadExisting: vi.fn() }),
}));
vi.mock('@/hooks/queries/use-product-types', () => ({
  useProductTypes: mockUseProductTypes,
  useCreateProductType: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateProductType: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetProductTypeActive: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-products', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-products')>()),
  useProducts: mockUseProducts,
  useUnpublishProduct: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useChangeProductStatus: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteProduct: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/components/supervisor/products/product-editor-dialog', () => ({ ProductEditorDialog: () => null }));

const { default: SupervisorProductsPage } = await import('./page');
const { BUILT_IN_PRODUCT_TYPES } = await import('@/lib/product-types');

function marketing(overrides: Partial<ProductTypeResponse> = {}): ProductTypeResponse {
  return { key: MARKETING_ID, id: MARKETING_ID, name: 'Marketing', description: 'Campaign items', is_builtin: false, is_active: true, version: 2, branches: [{ branch_id: 'branch-a', branch_name: 'Branch A' }], can_manage: true, product_count: 2, ...overrides };
}

function listResponse(products: Partial<ProductResponse>[] = []): { data: ProductListResponse; isLoading: boolean; isFetching: boolean; isError: boolean; isPlaceholderData: boolean; refetch: () => void } {
  return {
    data: { products: products as ProductResponse[], total: products.length, page: 1, limit: 25, counts: { active: products.length, drafts: 0, inactive: 0 }, type_counts: { regular: 3, [MARKETING_ID]: 2 } },
    isLoading: false,
    isFetching: false,
    isError: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  };
}

describe('SupervisorProductsPage by type (POS-PERF-P58)', () => {
  beforeEach(() => {
    search.value = '';
    mockUseProducts.mockReturnValue(listResponse());
    mockUseProductTypes.mockReturnValue({ data: [...BUILT_IN_PRODUCT_TYPES, marketing()], isSuccess: true });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('lists All Types, the built-ins and custom types with counts that add up', () => {
    render(<SupervisorProductsPage />);
    const nav = screen.getByRole('navigation', { name: 'Product types' });
    expect(nav).toHaveTextContent('All Types5');
    expect(nav).toHaveTextContent('Regular3');
    expect(nav).toHaveTextContent('Seasonal0');
    expect(nav).toHaveTextContent('Marketing2');
    expect(screen.getByTestId('product-type-nav-all')).toHaveAttribute('aria-current', 'true');
  });

  it('All Types offers the choose-type action, separate from Create Product Type', () => {
    render(<SupervisorProductsPage />);
    expect(screen.getByRole('button', { name: 'Create Product Type' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create Product' }));
    fireEvent.click(screen.getByTestId(`product-type-${MARKETING_ID}`));
    expect(mockReset).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith(`/supervisor/products/builder?type=${MARKETING_ID}`);
  });

  it('a selected type filters by the URL, and offers Create <Type> Product preselected', () => {
    search.value = `type=${MARKETING_ID}`;
    render(<SupervisorProductsPage />);
    expect(mockUseProducts).toHaveBeenCalledWith(expect.objectContaining({ productType: MARKETING_ID, classification: undefined, branchId: 'branch-a', view: 'active' }), expect.anything());
    expect(screen.getByTestId(`product-type-nav-${MARKETING_ID}`)).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('create-product')).toHaveTextContent('Create Marketing Product');
    fireEvent.click(screen.getByTestId('create-product'));
    expect(mockPush).toHaveBeenCalledWith(`/supervisor/products/builder?type=${MARKETING_ID}`);
  });

  it('a built-in also filters by classification, which is all an older API reads', () => {
    search.value = 'type=promotional';
    render(<SupervisorProductsPage />);
    expect(mockUseProducts).toHaveBeenCalledWith(expect.objectContaining({ productType: 'promotional', classification: 'promotional' }), expect.anything());
    expect(screen.getByTestId('create-product')).toHaveTextContent('Create Promotional Product');
  });

  it('choosing a type puts it in the URL; All Types takes it out', () => {
    render(<SupervisorProductsPage />);
    fireEvent.click(screen.getByTestId('product-type-nav-seasonal'));
    expect(mockReplace).toHaveBeenLastCalledWith('/supervisor/products?type=seasonal', { scroll: false });
    fireEvent.click(screen.getByTestId('product-type-nav-all'));
    expect(mockReplace).toHaveBeenLastCalledWith('/supervisor/products', { scroll: false });
  });

  it('an empty type view offers that type\'s Create action', () => {
    search.value = `type=${MARKETING_ID}`;
    render(<SupervisorProductsPage />);
    expect(screen.getByText('Nothing in Active is Marketing.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('empty-create-product'));
    expect(mockPush).toHaveBeenCalledWith(`/supervisor/products/builder?type=${MARKETING_ID}`);
  });

  it('an inactive type stays visible and labelled, can be reactivated, and offers no new products', () => {
    search.value = `type=${MARKETING_ID}`;
    mockUseProductTypes.mockReturnValue({ data: [...BUILT_IN_PRODUCT_TYPES, marketing({ is_active: false })], isSuccess: true });
    render(<SupervisorProductsPage />);
    expect(screen.getByTestId(`product-type-nav-${MARKETING_ID}`)).toHaveTextContent('(inactive)');
    expect(screen.getByTestId('product-type-summary')).toHaveTextContent('Existing products keep it');
    expect(screen.getByRole('button', { name: 'Reactivate Type' })).toBeInTheDocument();
    expect(screen.queryByTestId('create-product')).not.toBeInTheDocument();
    expect(screen.queryByTestId('empty-create-product')).not.toBeInTheDocument();
  });

  it('a type shared beyond the supervisor\'s branches can be used but not changed', () => {
    search.value = `type=${MARKETING_ID}`;
    mockUseProductTypes.mockReturnValue({ data: [...BUILT_IN_PRODUCT_TYPES, marketing({ can_manage: false })], isSuccess: true });
    render(<SupervisorProductsPage />);
    expect(screen.queryByRole('button', { name: 'Edit Type' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate Type' })).not.toBeInTheDocument();
    expect(screen.getByTestId('product-type-summary')).toHaveTextContent('you can use it but not change it');
    expect(screen.getByTestId('create-product')).toHaveTextContent('Create Marketing Product');
  });

  it('a type not usable at this branch falls back to All Types', () => {
    search.value = 'type=9c9a9a9a-1111-4222-8333-444444444444';
    render(<SupervisorProductsPage />);
    expect(mockReplace).toHaveBeenCalledWith('/supervisor/products', { scroll: false });
  });

  it('with no type list (an older API) the built-ins still work', () => {
    mockUseProductTypes.mockReturnValue({ data: undefined, isSuccess: false });
    render(<SupervisorProductsPage />);
    expect(screen.getByTestId('product-type-nav-regular')).toBeInTheDocument();
    expect(screen.getByTestId('product-type-nav-seasonal')).toBeInTheDocument();
  });

  it('the row shows the actual type name, labelled when inactive', () => {
    const row = { id: 'p1', name: 'Campaign Fries', status: 'active', status_label: 'Active', has_image: false, category_name: null, version: 1, branches: [{ branch_id: 'branch-a', branch_name: 'Branch A', is_available: true }], product_type: { key: MARKETING_ID, id: MARKETING_ID, name: 'Marketing', is_builtin: false, is_active: false } } as Partial<ProductResponse>;
    mockUseProducts.mockReturnValue(listResponse([row]));
    render(<SupervisorProductsPage />);
    expect(screen.getByTestId('product-row-type')).toHaveTextContent('Marketing (inactive)');
  });
});
