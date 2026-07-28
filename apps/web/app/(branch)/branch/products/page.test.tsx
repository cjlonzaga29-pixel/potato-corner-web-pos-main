import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import BranchProductsPage from './page';
import type { PosCatalogProduct } from '@potato-corner/shared';

const { mockUseCatalog } = vi.hoisted(() => ({ mockUseCatalog: vi.fn() }));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { branchIds: ['branch-1'] } }),
}));

vi.mock('@/hooks/queries/use-products', () => ({
  useCatalog: mockUseCatalog,
  useCatalogRealtimeSync: () => undefined,
}));

function variant(overrides: Partial<PosCatalogProduct['variants'][number]> = {}): PosCatalogProduct['variants'][number] {
  return {
    id: 'variant-1',
    name: 'Regular',
    size_label: 'Large',
    price: 100,
    vatable_cap_amount: null,
    live_ready: true,
    readiness_code: 'READY',
    missing_flavor_ids: [],
    flavors: [],
    flavor_slots: [],
    option_groups: [],
    ...overrides,
  };
}

function catalogWith(variants: PosCatalogProduct['variants'][number][]) {
  return { categories: ['Snacks'], products: [{ id: 'product-1', name: 'Mega Mix Fries', category: 'Snacks', image_url: null, variants }] };
}

afterEach(() => cleanup());

describe('BranchProductsPage — live POS readiness badges', () => {
  it('shows a "Ready" badge for a live-ready variant', () => {
    mockUseCatalog.mockReturnValue({ data: catalogWith([variant()]), isLoading: false, isError: false, refetch: vi.fn() });
    render(<BranchProductsPage />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('shows a "Missing Base Mapping" badge and never labels an incomplete variant as Ready', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([variant({ live_ready: false, readiness_code: 'MISSING_BASE_MAPPING' })]),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<BranchProductsPage />);
    expect(screen.getByText('Missing Base Mapping')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  it('shows a "Missing Flavor Mapping" badge for a variant with an unmapped linked flavor', () => {
    mockUseCatalog.mockReturnValue({
      data: catalogWith([variant({ live_ready: false, readiness_code: 'MISSING_FLAVOR_MAPPING', missing_flavor_ids: ['flavor-1'] })]),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<BranchProductsPage />);
    expect(screen.getByText('Missing Flavor Mapping')).toBeInTheDocument();
  });
});
