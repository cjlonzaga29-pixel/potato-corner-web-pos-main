import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import ProductDetailPage from './page';
import type { ProductDetailResponse, ProductReadinessResponse, ProductVariantResponse } from '@potato-corner/shared';

const { mockPush, mockUseProduct, mockUseSelectedBranch, mockVariantCard, mockUseProductReadiness } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseProduct: vi.fn(),
  mockUseSelectedBranch: vi.fn(),
  mockVariantCard: vi.fn(),
  mockUseProductReadiness: vi.fn(),
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

  function Tabs({
    value: controlledValue,
    defaultValue,
    onValueChange,
    children,
  }: {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    children?: React.ReactNode;
  }) {
    const [internalValue, setInternalValue] = React.useState(defaultValue);
    const value = controlledValue ?? internalValue;
    const handleChange = (next: string) => {
      if (controlledValue === undefined) setInternalValue(next);
      onValueChange?.(next);
    };
    return <TabsContext.Provider value={{ value, onValueChange: handleChange }}>{children}</TabsContext.Provider>;
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
  useChangeProductStatus: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteVariant: () => ({ mutateAsync: vi.fn() }),
  useDeleteProductImage: () => ({ mutateAsync: vi.fn() }),
  useBranchProductAvailability: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateBranchProductAvailability: () => ({ mutateAsync: vi.fn() }),
  useBulkUpdateBranchProductAvailability: () => ({ mutateAsync: vi.fn() }),
  useProductReadiness: mockUseProductReadiness,
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

function readiness(overrides: Partial<ProductReadinessResponse> = {}): ProductReadinessResponse {
  return {
    scope: 'branch',
    product_id: 'product-1',
    branch_id: 'branch-1',
    status: 'NOT_READY',
    sellable: false,
    completion_percentage: 50,
    variant_count: 1,
    eligible_variant_count: 1,
    ready_variant_count: 0,
    blocking_issues: [],
    warnings: [],
    variants: [],
    publish_is_variant_level: false,
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
  mockUseProductReadiness.mockReturnValue({ data: readiness(), isLoading: false, isError: false, refetch: vi.fn() });
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

  it('shows Archive instead of Delete for an active product', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('shows Restore instead of Archive/Edit for an archived product', async () => {
    mockUseProduct.mockReturnValue({ data: product({ status: 'archived', status_label: 'Archived' }), isLoading: false, isError: false, refetch: vi.fn() });
    await renderPage();

    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Product' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  describe('Readiness checklist embedded in Variants & Flavors tab', () => {
    it('renders the ReadinessChecklist with the data from the shared readiness query', async () => {
      mockUseProductReadiness.mockReturnValue({
        data: readiness({
          blocking_issues: [
            {
              code: 'NO_RECIPE',
              severity: 'blocking',
              entity_type: 'product_variant',
              message: 'Large Cup has no recipe configured',
              recommended_action: 'Add a recipe for this variant',
              flavor_name: null,
            },
          ],
        }),
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      await renderPage();
      fireEvent.click(screen.getByRole('tab', { name: 'Variants & Flavors' }));

      expect(mockUseProductReadiness).toHaveBeenCalledWith('product-1', 'branch-1');
      expect(screen.getByText('Large Cup has no recipe configured')).toBeInTheDocument();
    });

    it('keeps the Variants tab active when the checklist Variants quick-action is clicked', async () => {
      await renderPage();
      fireEvent.click(screen.getByRole('tab', { name: 'Variants & Flavors' }));

      fireEvent.click(screen.getByRole('button', { name: 'Manage Variants, Flavors, Inventory Mapping & Recipe/BOM' }));

      expect(screen.getByRole('tab', { name: 'Variants & Flavors' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('Large Cup')).toBeInTheDocument();
    });

    it('scrolls/focuses the inline Branch Availability section when the checklist availability quick-action is clicked, without switching tabs', async () => {
      await renderPage();
      fireEvent.click(screen.getByRole('tab', { name: 'Variants & Flavors' }));

      const scrollIntoViewSpy = vi.fn();
      HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;

      fireEvent.click(screen.getByRole('button', { name: 'Manage Branch Availability' }));

      expect(scrollIntoViewSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth', block: 'start' }));
      expect(screen.getByRole('tab', { name: 'Variants & Flavors' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('Large Cup')).toBeInTheDocument();
    });

    it('still renders the existing variant cards alongside the checklist', async () => {
      await renderPage();
      fireEvent.click(screen.getByRole('tab', { name: 'Variants & Flavors' }));

      expect(screen.getByTestId('variant-card-variant-1')).toBeInTheDocument();
      expect(screen.getByText('No blocking issues.')).toBeInTheDocument();
    });

    it('does not render a standalone Readiness tab', async () => {
      await renderPage();

      expect(screen.queryByRole('tab', { name: 'Readiness' })).not.toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Variants & Flavors' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Media' })).toBeInTheDocument();
    });
  });

  describe('Branch Availability embedded in Variants & Flavors tab', () => {
    it('does not render a standalone Branch Availability tab', async () => {
      await renderPage();

      expect(screen.queryByRole('tab', { name: 'Branch Availability' })).not.toBeInTheDocument();
    });

    it('renders the Branch Availability section inline within the Variants & Flavors tab', async () => {
      await renderPage();
      fireEvent.click(screen.getByRole('tab', { name: 'Variants & Flavors' }));

      expect(screen.getByText('Branch Availability')).toBeInTheDocument();
      expect(screen.getByText('Large Cup')).toBeInTheDocument();
    });
  });
});
