import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { RecipeReadinessReport } from './recipe-readiness-report';

const { mockUseRecipeReadiness } = vi.hoisted(() => ({ mockUseRecipeReadiness: vi.fn() }));

vi.mock('@/hooks/queries/use-recipe-readiness', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/queries/use-recipe-readiness')>('@/hooks/queries/use-recipe-readiness');
  return { ...actual, useRecipeReadiness: mockUseRecipeReadiness };
});

/** Flat, always-rendered list — same approach as notification-preferences-section.test.tsx for the real Radix Select. */
vi.mock('@/components/ui/select', () => {
  function Select({ children }: { children?: React.ReactNode }) {
    return <div>{children}</div>;
  }
  function SelectTrigger({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectValue() {
    return null;
  }
  function SelectContent({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectItem({ children }: { value: string; children?: React.ReactNode }) {
    return <>{children}</>;
  }
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const REPORT = {
  generated_at: '2026-07-28T00:00:00.000Z',
  summary: { total_variants: 2, ready_count: 1, blocked_count: 1, readiness_percentage: 50, counts_by_status: { READY: 1, NO_RECIPE: 1 } },
  variants: [
    {
      product_id: 'p1',
      product_name: 'Fries',
      product_variant_id: 'v1',
      variant_name: 'Regular',
      size_label: 'Regular',
      status: 'READY' as const,
      blockers: [],
      affected_branch_ids: [],
      affected_inventory_item_ids: [],
      available_branch_ids: ['branch-1'],
    },
    {
      product_id: 'p2',
      product_name: 'Chili Cheese',
      product_variant_id: 'v2',
      variant_name: 'Regular',
      size_label: 'Regular',
      status: 'NO_RECIPE' as const,
      blockers: [{ code: 'NO_RECIPE' as const, message: 'Variant has no active ProductComponent rows.', inventory_item_ids: [], branch_ids: [] }],
      affected_branch_ids: [],
      affected_inventory_item_ids: [],
      available_branch_ids: ['branch-1'],
    },
  ],
};

describe('RecipeReadinessReport', () => {
  it('shows a loading spinner while the report is loading', () => {
    mockUseRecipeReadiness.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { container } = render(<RecipeReadinessReport />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows an error message when the report fails to load', () => {
    mockUseRecipeReadiness.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<RecipeReadinessReport />);
    expect(screen.getByText(/failed to load the recipe readiness report/i)).toBeTruthy();
  });

  it('renders summary counts and per-variant status badges with blocker reasons', () => {
    mockUseRecipeReadiness.mockReturnValue({ data: REPORT, isLoading: false, isError: false });
    render(<RecipeReadinessReport />);

    expect(screen.getByText('2')).toBeTruthy(); // total variants
    expect(screen.getByText('50%')).toBeTruthy(); // readiness percentage
    expect(screen.getByText(/Fries — Regular/)).toBeTruthy();
    expect(screen.getByText(/Chili Cheese — Regular/)).toBeTruthy();
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No Recipe').length).toBeGreaterThan(0);
    expect(screen.getByText(/Variant has no active ProductComponent rows\./)).toBeTruthy();
  });

  it('passes branchId through to the underlying query filters', () => {
    mockUseRecipeReadiness.mockReturnValue({ data: REPORT, isLoading: false, isError: false });
    render(<RecipeReadinessReport branchId="branch-1" />);

    expect(mockUseRecipeReadiness).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'branch-1' }));
  });

  it('shows an empty state when no variants match the filters', () => {
    mockUseRecipeReadiness.mockReturnValue({
      data: { ...REPORT, variants: [] },
      isLoading: false,
      isError: false,
    });
    render(<RecipeReadinessReport />);

    expect(screen.getByText(/no variants match the current filters/i)).toBeTruthy();
  });
});
