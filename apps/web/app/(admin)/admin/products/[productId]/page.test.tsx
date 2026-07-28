import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import ProductDetailPage from './page';
import type { ProductDetailResponse, ProductVariantResponse } from '@potato-corner/shared';

const { mockPush, mockUseProduct, mockUseSelectedBranch, mockVariantCard } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseProduct: vi.fn(),
  mockUseSelectedBranch: vi.fn(),
  mockVariantCard: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

/**
 * Real Radix Tabs uses pointer-event-based activation with no jsdom-friendly
 * interaction path without @testing-library/user-event (same reasoning as
 * settings/page.test.tsx's Tabs mock) — stand it up as a plain, uncontrolled,
 * click-responsive set of elements that keep the same ARIA roles.
 */
vi.mock('@/components/ui/tabs', () => {
  const TabsContext = React.createContext<{ value?: string; onValueChange?: (value: string) => void }>({});

  function Tabs({ defaultValue, children }: { defaultValue?: string; children?: React.ReactNode }) {
    const [value, setValue] = React.useState(defaultValue);
    return <TabsContext.Provider value={{ value, onValueChange: setValue }}>{children}</TabsContext.Provider>;
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
  function TabsContent({ value, children }: { value: string; children?: React.ReactNode }) {
    const ctx = React.useContext(TabsContext);
    if (ctx.value !== value) return null;
    return <div>{children}</div>;
  }
  return { Tabs, TabsList, TabsTrigger, TabsContent };
});

vi.mock('@/hooks/use-selected-branch', () => ({
  useSelectedBranch: mockUseSelectedBranch,
}));

vi.mock('@/hooks/queries/use-products', () => ({
  useProduct: mockUseProduct,
  useDeleteProduct: () => ({ mutateAsync: vi.fn() }),
  useDeleteVariant: () => ({ mutateAsync: vi.fn() }),
  useDeleteProductImage: () => ({ mutateAsync: vi.fn() }),
  useBranchProductAvailability: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateBranchProductAvailability: () => ({ mutateAsync: vi.fn() }),
  useBulkUpdateBranchProductAvailability: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('@/components/admin/products/variant-card', () => ({
  VariantCard: (props: { variant: ProductVariantResponse; branchId: string | null; branchName?: string | null }) => {
    mockVariantCard(props);
    return <div data-testid={`variant-card-${props.variant.id}`}>{props.variant.name}</div>;
  },
}));

vi.mock('@/components/admin/products/edit-product-dialog', () => ({ EditProductDialog: () => null }));
vi.mock('@/components/admin/products/change-product-status-dialog', () => ({ ChangeProductStatusDialog: () => null }));
vi.mock('@/components/admin/products/upload-product-image-dialog', () => ({ UploadProductImageDialog: () => null }));
vi.mock('@/components/admin/products/variant-form-dialog', () => ({ VariantFormDialog: () => null }));
vi.mock('@/components/admin/products/link-flavor-dialog', () => ({ LinkFlavorDialog: () => null }));
vi.mock('@/components/admin/products/edit-variant-flavor-dialog', () => ({ EditVariantFlavorDialog: () => null }));

function variant(overrides: Partial<ProductVariantResponse> = {}): ProductVariantResponse {
  return {
    id: 'variant-1',
    product_id: 'product-1',
    name: 'Large Cup',
    size_label: 'Large',
    base_price: 65,
    display_order: 0,
    is_active: true,
    flavors: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function product(overrides: Partial<ProductDetailResponse> = {}): ProductDetailResponse {
  return {
    id: 'product-1',
    name: 'Potato Corner Regular',
    description: null,
    category: 'Snacks',
    category_id: null,
    category_name: null,
    image_url: null,
    status: 'active',
    status_label: 'Active',
    display_order: 0,
    is_seasonal: false,
    seasonal_start_date: null,
    seasonal_end_date: null,
    branch_exclusive: false,
    exclusive_branch_id: null,
    exclusive_branch_name: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    variant_count: 1,
    active_variant_count: 1,
    active_branch_count: 1,
    variants: [variant()],
    branch_availability: [],
    created_by_user: null,
    ...overrides,
  };
}

async function renderPage() {
  await act(async () => {
    render(<ProductDetailPage params={Promise.resolve({ productId: 'product-1' })} />);
  });
}

beforeEach(() => {
  mockUseProduct.mockReturnValue({ data: product(), isLoading: false, isError: false, refetch: vi.fn() });
  mockUseSelectedBranch.mockReturnValue({
    selectedBranchId: 'branch-1',
    availableBranches: [{ id: 'branch-1', name: 'Downtown', code: 'DT' }],
    setSelectedBranch: vi.fn(),
    allLabel: 'All Branches',
    isSingleBranchUser: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProductDetailPage', () => {
  it('passes the selected branch ID unchanged to VariantCard', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Variants & Flavors' }));

    expect(mockVariantCard).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'branch-1' }));
  });

  it('still renders VariantCard with a null branchId when no branch is selected', async () => {
    mockUseSelectedBranch.mockReturnValue({
      selectedBranchId: 'all',
      availableBranches: [{ id: 'branch-1', name: 'Downtown', code: 'DT' }],
      setSelectedBranch: vi.fn(),
      allLabel: 'All Branches',
      isSingleBranchUser: true,
    });
    await renderPage();

    fireEvent.click(screen.getByRole('tab', { name: 'Variants & Flavors' }));

    expect(mockVariantCard).toHaveBeenCalledWith(expect.objectContaining({ branchId: null }));
    expect(screen.getByText('Large Cup')).toBeInTheDocument();
  });

  it('renders the branch selector on the Variants & Flavors tab and passes the selected branch name to VariantCard', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Variants & Flavors' }));

    expect(screen.getByText('Downtown')).toBeInTheDocument();
    expect(mockVariantCard).toHaveBeenCalledWith(expect.objectContaining({ branchName: 'Downtown' }));
  });

  it('renders existing product and variant info unchanged', async () => {
    await renderPage();

    expect(screen.getByText('Potato Corner Regular')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Variants & Flavors' }));
    expect(screen.getByText('Large Cup')).toBeInTheDocument();
  });
});
