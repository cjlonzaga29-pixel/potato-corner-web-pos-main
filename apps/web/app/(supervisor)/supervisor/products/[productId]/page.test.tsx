import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import SupervisorProductDetailPage from './page';
import type { ProductDetailResponse, ProductReadinessResponse, PublicationCheckResponse } from '@potato-corner/shared';

const { mockUseProduct, mockUseProductReadiness, mockUsePublicationCheck, mockPublish } = vi.hoisted(() => ({
  mockUseProduct: vi.fn(),
  mockUseProductReadiness: vi.fn(),
  mockUsePublicationCheck: vi.fn(),
  mockPublish: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

/** Same plain Tabs stand-in as the admin product page test (Radix Tabs has no jsdom-friendly click path). */
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
  function TabsContent({ value, children }: { value: string; children?: React.ReactNode }) {
    const ctx = React.useContext(TabsContext);
    return ctx.value === value ? <div>{children}</div> : null;
  }
  return { Tabs, TabsList, TabsTrigger, TabsContent };
});

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'sup-1', role: 'supervisor', branchIds: ['branch-1'] } }) }));

vi.mock('@/hooks/queries/use-products', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/queries/use-products')>();
  return {
    ...actual,
    useProduct: mockUseProduct,
    useChangeProductStatus: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useDeleteVariant: () => ({ mutateAsync: vi.fn() }),
    useProductReadiness: mockUseProductReadiness,
    useProductImage: () => ({ data: null, isLoading: false }),
    useUploadProductImage: () => ({ mutateAsync: vi.fn(), isPending: false }),
    usePublishProduct: () => ({ mutateAsync: mockPublish, isPending: false }),
    usePublicationCheck: mockUsePublicationCheck,
    useUnpublishProduct: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});

vi.mock('@/components/admin/products/variant-card', () => ({ VariantCard: () => null }));
vi.mock('@/components/admin/products/edit-product-dialog', () => ({ EditProductDialog: () => null }));
vi.mock('@/components/admin/products/change-product-status-dialog', () => ({ ChangeProductStatusDialog: () => null }));
vi.mock('@/components/admin/products/variant-form-dialog', () => ({ VariantFormDialog: () => null }));
vi.mock('@/components/admin/products/link-flavor-dialog', () => ({ LinkFlavorDialog: () => null }));
vi.mock('@/components/admin/products/edit-variant-flavor-dialog', () => ({ EditVariantFlavorDialog: () => null }));
vi.mock('@/components/admin/products/branch-copy-dialog', () => ({ BranchCopyDialog: () => null }));
vi.mock('@/components/admin/products/replace-source-dialog', () => ({ ReplaceSourceDialog: () => null }));

function product(overrides: Partial<ProductDetailResponse> = {}): ProductDetailResponse {
  return {
    id: 'product-1',
    name: 'Cheese Fries',
    description: null,
    category: 'Snacks',
    category_id: null,
    category_name: null,
    has_image: false,
    status: 'active',
    status_label: 'Active',
    display_order: 0,
    is_seasonal: false,
    seasonal_start_date: null,
    seasonal_end_date: null,
    branch_exclusive: true,
    exclusive_branch_id: 'branch-1',
    exclusive_branch_name: 'Downtown',
    created_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    variant_count: 0,
    active_variant_count: 0,
    active_branch_count: 0,
    version: 1,
    variants: [],
    branch_availability: [{ branch_id: 'branch-1', branch_code: 'DT', branch_name: 'Downtown', city: 'Manila', is_available: false, updated_at: null }],
    created_by_user: null,
    ...overrides,
  } as ProductDetailResponse;
}

/** Sale readiness still reports the unpublished state and the missing link — neither may disable Publish. */
function readiness(): ProductReadinessResponse {
  const issue = (code: string, message: string) => ({
    code,
    severity: 'blocking',
    entity_type: 'product',
    entity_id: 'product-1',
    message,
    recommended_action: '',
  });
  return {
    scope: 'branch',
    product_id: 'product-1',
    branch_id: 'branch-1',
    status: 'NOT_READY',
    sellable: false,
    completion_percentage: 80,
    variant_count: 1,
    eligible_variant_count: 1,
    ready_variant_count: 0,
    blocking_issues: [
      issue('BRANCH_NOT_AVAILABLE', 'Cheese Fries is not available at this branch.'),
      issue('INVENTORY_STOCK_MISSING', 'Regular has a Recipe/BOM component with no InventoryStock row at this branch.'),
    ],
    warnings: [],
    variants: [],
    publish_is_variant_level: false,
  } as unknown as ProductReadinessResponse;
}

function plan(overrides: Partial<PublicationCheckResponse> = {}): PublicationCheckResponse {
  return {
    product_id: 'product-1',
    ready: true,
    issues: [],
    branches: [
      {
        branch_id: 'branch-1',
        branch_name: 'Downtown',
        is_published: false,
        status: 'ready',
        issues: [],
        notices: [],
        setup_items: [{ inventory_item_id: 'item-1', name: 'Cheese Powder' }],
      },
    ],
    ...overrides,
  };
}

async function renderVariantsTab() {
  await act(async () => {
    render(<SupervisorProductDetailPage params={Promise.resolve({ productId: 'product-1' })} />);
  });
  fireEvent.click(screen.getByRole('tab', { name: /Variants, Flavors & Recipe/ }));
}

beforeEach(() => {
  mockUseProduct.mockReturnValue({ data: product(), isLoading: false, isError: false, refetch: vi.fn() });
  mockUseProductReadiness.mockReturnValue({ data: readiness(), isLoading: false, isError: false, refetch: vi.fn() });
  mockUsePublicationCheck.mockReturnValue({ data: plan(), isLoading: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SupervisorProductDetailPage Publish (POS-PERF-P38R)', () => {
  it('checks publication for this branch only, and enables Publish despite a missing link and the unpublished state', async () => {
    await renderVariantsTab();

    expect(mockUsePublicationCheck).toHaveBeenCalledWith('product-1', ['branch-1']);
    expect(screen.getByTestId('publication-summary')).toHaveTextContent('Ready to publish.');
    expect(screen.getByTestId('publication-setup-items')).toHaveTextContent('Cheese Powder');
    const publish = screen.getByRole('button', { name: 'Publish' });
    expect(publish).toBeEnabled();

    mockPublish.mockResolvedValue({ branch_id: 'branch-1', is_available: true });
    await act(async () => {
      fireEvent.click(publish);
    });
    expect(mockPublish).toHaveBeenCalledWith('branch-1');
    expect(screen.queryByTestId('product-publish-error')).not.toBeInTheDocument();
  });

  it('disables Publish with an actionable message when setup is genuinely missing', async () => {
    mockUsePublicationCheck.mockReturnValue({
      data: plan({
        ready: false,
        issues: [{ code: 'UNIT_CONVERSION_MISSING', message: 'Regular: "Potato" is entered in kg, but there is no conversion from kg to g.', fix_step: 'ingredients' }],
      }),
      isLoading: false,
      error: null,
    });
    await renderVariantsTab();

    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByTestId('publication-summary')).toHaveTextContent('Fix the setup below before publishing.');
    expect(screen.getByTestId('publication-issues')).toHaveTextContent('no conversion from kg to g');
  });

  it('keeps a failed publish on screen with its own message, not a maintenance notice', async () => {
    const { ProductApiError } = await import('@/hooks/queries/use-products');
    mockPublish.mockRejectedValue(new ProductApiError('Product setup is incomplete. Nothing was published.', 'PRODUCT_NOT_READY'));
    await renderVariantsTab();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    });
    const error = screen.getByTestId('product-publish-error');
    expect(error).toHaveTextContent("Couldn't publish this product");
    expect(error).toHaveTextContent('Product setup is incomplete. Nothing was published.');
    expect(error).not.toHaveTextContent('paused');
    // The screen is intact: still on the same tab with the Publish control.
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
  });

  it('describes only SERVICE_WRITE_GATE_CLOSED as maintenance', async () => {
    const { ProductApiError } = await import('@/hooks/queries/use-products');
    mockPublish.mockRejectedValue(new ProductApiError('Service temporarily unavailable', 'SERVICE_WRITE_GATE_CLOSED'));
    await renderVariantsTab();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    });
    expect(screen.getByTestId('product-publish-error')).toHaveTextContent('Publishing is paused for maintenance');
  });

  it('does not check publication once the product is on POS at this branch', async () => {
    mockUseProduct.mockReturnValue({
      data: product({
        branch_availability: [{ branch_id: 'branch-1', branch_code: 'DT', branch_name: 'Downtown', city: 'Manila', is_available: true, updated_at: null }],
      } as Partial<ProductDetailResponse>),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    await renderVariantsTab();

    expect(mockUsePublicationCheck).toHaveBeenCalledWith('product-1', []);
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeInTheDocument();
  });
});
