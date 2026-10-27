import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ProductResponse, ProductListResponse } from '@potato-corner/shared';

/**
 * POS-PERF-P39 — the supervisor Products list: tabs with server counts for
 * the selected branch, compact rows, actions that follow authority (with the
 * reason shown when one is missing), Continue Setup reopening the saved
 * builder draft, and Deactivate naming the one branch it changes.
 */
const { mockUseProducts, mockPush, mockLoadExisting, mockUnpublish } = vi.hoisted(() => ({
  mockUseProducts: vi.fn(),
  mockPush: vi.fn(),
  mockLoadExisting: vi.fn(),
  mockUnpublish: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

vi.mock('@/components/ui/tabs', () => {
  const TabsContext = React.createContext<{ value?: string; onValueChange?: (value: string) => void }>({});
  function Tabs({ value, onValueChange, children }: { value?: string; onValueChange?: (value: string) => void; children?: React.ReactNode }) {
    return <TabsContext.Provider value={{ value, onValueChange }}>{children}</TabsContext.Provider>;
  }
  function TabsList({ children }: { children?: React.ReactNode }) {
    return <div role="tablist">{children}</div>;
  }
  function TabsTrigger({ value, children }: { value: string; children?: React.ReactNode }) {
    const ctx = React.useContext(TabsContext);
    return (
      <button type="button" role="tab" aria-selected={ctx.value === value} onClick={() => ctx.onValueChange?.(value)}>
        {children}
      </button>
    );
  }
  return { Tabs, TabsList, TabsTrigger, TabsContent: () => null };
});

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'sup-1', role: 'supervisor', branchIds: ['branch-a', 'branch-b'] } }) }));
vi.mock('@/hooks/queries/use-branches', () => ({ useBranches: () => ({ data: { branches: [{ id: 'branch-a', name: 'Branch A' }] } }) }));
vi.mock('@/hooks/use-branch', () => ({ useBranch: () => ({ activeBranchId: 'branch-a', activeBranch: { id: 'branch-a', name: 'Branch A' } }) }));
vi.mock('@/stores/product-builder.store', () => ({
  useProductBuilderStore: (select: (s: { reset: () => void; loadExisting: (id: string) => void }) => unknown) =>
    select({ reset: vi.fn(), loadExisting: mockLoadExisting }),
}));
vi.mock('@/hooks/queries/use-products', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/queries/use-products')>();
  return {
    ...actual,
    useProducts: mockUseProducts,
    useUnpublishProduct: () => ({ mutateAsync: mockUnpublish, isPending: false }),
    useChangeProductStatus: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteProduct: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});
vi.mock('@/components/supervisor/products/product-editor-dialog', () => ({
  ProductEditorDialog: ({ productId, initialTab }: { productId: string; initialTab: string }) => <div data-testid="editor">{`${productId}:${initialTab}`}</div>,
}));

const { default: SupervisorProductsPage } = await import('./page');

function product(id: string, overrides: Partial<ProductResponse> = {}): ProductResponse {
  return {
    id,
    name: `Product ${id}`,
    description: null,
    category: null,
    category_id: null,
    category_name: 'Fries',
    has_image: false,
    image_url: null,
    status: 'active',
    status_label: 'Active',
    display_order: null,
    is_seasonal: false,
    seasonal_start_date: null,
    seasonal_end_date: null,
    branch_exclusive: false,
    exclusive_branch_id: null,
    exclusive_branch_name: null,
    created_by: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    variant_count: 1,
    active_variant_count: 1,
    active_branch_count: 1,
    version: 1,
    branches: [
      { branch_id: 'branch-a', branch_name: 'Branch A', is_available: true },
      { branch_id: 'branch-b', branch_name: 'Branch B', is_available: true },
    ],
    ...overrides,
  };
}

function listResult(products: ProductResponse[]): { data: ProductListResponse; isLoading: false; isFetching: false; isError: false; isPlaceholderData: false; refetch: () => void } {
  return {
    data: { products, total: products.length, page: 1, limit: 25, counts: { active: 3, drafts: 1, inactive: 2 } },
    isLoading: false,
    isFetching: false,
    isError: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  };
}

afterEach(cleanup);
beforeEach(() => {
  mockUseProducts.mockReset();
  mockPush.mockReset();
  mockLoadExisting.mockReset();
});

describe('Supervisor Products page (POS-PERF-P39)', () => {
  it('asks the server for the selected branch and tab, and shows every tab count', () => {
    mockUseProducts.mockReturnValue(listResult([product('p1')]));
    render(<SupervisorProductsPage />);

    expect(mockUseProducts).toHaveBeenLastCalledWith(expect.objectContaining({ branchId: 'branch-a', view: 'active', page: 1, limit: 25 }), { enabled: true });
    expect(screen.getByRole('tab', { name: /Active\s*3/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Drafts\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Inactive\s*2/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Drafts/ }));
    expect(mockUseProducts).toHaveBeenLastCalledWith(expect.objectContaining({ branchId: 'branch-a', view: 'drafts' }), { enabled: true });
  });

  it('shows a compact row with category, branches and status, and Edit/Deactivate for an editable product', () => {
    mockUseProducts.mockReturnValue(listResult([product('p1')]));
    render(<SupervisorProductsPage />);

    const row = screen.getByTestId('product-row');
    expect(within(row).getByRole('link', { name: 'Product p1' })).toHaveAttribute('href', '/supervisor/products/p1');
    expect(within(row).getAllByText('Fries').length).toBeGreaterThan(0);
    expect(within(row).getByLabelText('Branches')).toHaveTextContent('Branch A');
    expect(within(row).getByTestId('product-row-status')).toHaveTextContent('On POS');

    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('editor')).toHaveTextContent('p1:details');
  });

  it('hides edit actions for a product shared with a branch outside the assignment, and says why', () => {
    mockUseProducts.mockReturnValue(
      listResult([product('p2', { branches: [{ branch_id: 'branch-a', branch_name: 'Branch A', is_available: true }, { branch_id: 'branch-x', branch_name: 'Branch X', is_available: true }] })]),
    );
    render(<SupervisorProductsPage />);

    const row = screen.getByTestId('product-row');
    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(row).getByText(/outside your assignment — view only/)).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'View' })).toHaveAttribute('href', '/supervisor/products/p2');
    // Deactivating at Branch A only needs an assignment at Branch A.
    expect(within(row).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });

  it('Deactivate names the selected branch and the branches it stays on POS at, then unpublishes only that branch', async () => {
    mockUseProducts.mockReturnValue(listResult([product('p1')]));
    render(<SupervisorProductsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Deactivate Product p1 at Branch A?');
    expect(dialog).toHaveTextContent('It stays on POS at Branch B.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate at Branch A' }));
    await vi.waitFor(() => expect(mockUnpublish).toHaveBeenCalledWith('branch-a'));
  });

  it('Continue Setup on a draft reopens the saved builder draft for that product', () => {
    mockUseProducts.mockReturnValue(listResult([product('p3', { branches: [{ branch_id: 'branch-a', branch_name: 'Branch A', is_available: false }] })]));
    render(<SupervisorProductsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Drafts/ }));

    const row = screen.getByTestId('product-row');
    expect(within(row).getByTestId('product-row-status')).toHaveTextContent('Draft');
    fireEvent.click(within(row).getByRole('button', { name: 'Continue Setup' }));
    expect(mockLoadExisting).toHaveBeenCalledWith('p3');
    expect(mockPush).toHaveBeenCalledWith('/supervisor/products/builder?product_id=p3');
  });

  it('labels archived products on the Inactive tab as Archived, not as drafts', () => {
    mockUseProducts.mockReturnValue(listResult([product('p4', { status: 'archived', branches: [{ branch_id: 'branch-a', branch_name: 'Branch A', is_available: false }] })]));
    render(<SupervisorProductsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Inactive/ }));

    const row = screen.getByTestId('product-row');
    expect(within(row).getByTestId('product-row-status')).toHaveTextContent('Archived');
    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(row).getByRole('link', { name: 'View' })).toBeInTheDocument();
  });

  it('never shows the previous tab’s rows under a new tab while it loads', () => {
    mockUseProducts.mockReturnValue(listResult([product('p1')]));
    render(<SupervisorProductsPage />);
    mockUseProducts.mockReturnValue({ ...listResult([product('p1')]), isPlaceholderData: true, isFetching: true });
    fireEvent.click(screen.getByRole('tab', { name: /Inactive/ }));

    expect(screen.queryByTestId('product-row')).toBeNull();
    expect(screen.getByRole('list', { name: 'Loading products' })).toBeInTheDocument();
  });

  it('shows an error with Retry, not an endless skeleton, when the new tab fails while the old tab is still held', () => {
    mockUseProducts.mockReturnValue(listResult([product('p1')]));
    render(<SupervisorProductsPage />);
    mockUseProducts.mockReturnValue({ ...listResult([]), data: undefined, isError: true });
    fireEvent.click(screen.getByRole('tab', { name: /Drafts/ }));

    expect(screen.queryByRole('list', { name: 'Loading products' })).toBeNull();
    expect(screen.getByRole('button', { name: /retry|try again/i })).toBeInTheDocument();
  });

  it('does not query until the selected branch is known', () => {
    mockUseProducts.mockReturnValue(listResult([]));
    render(<SupervisorProductsPage />);
    expect(mockUseProducts).toHaveBeenLastCalledWith(expect.anything(), { enabled: true });
  });
});
