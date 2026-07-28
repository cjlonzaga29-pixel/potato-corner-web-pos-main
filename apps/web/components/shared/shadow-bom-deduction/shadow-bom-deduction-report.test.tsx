import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import * as React from 'react';
import type { BranchListResponse, BranchResponse, ShadowBomDeductionDetailsPage, ShadowBomDeductionSummary } from '@potato-corner/shared';
import { ShadowBomDeductionReport } from './shadow-bom-deduction-report';

const {
  mockPush,
  mockUsePathname,
  mockUseSearchParams,
  mockUseShadowBomDeductionSummary,
  mockUseShadowBomDeductionDetails,
  mockUseBranches,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUsePathname: vi.fn(() => '/admin/shadow-bom-deduction'),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
  mockUseShadowBomDeductionSummary: vi.fn(),
  mockUseShadowBomDeductionDetails: vi.fn(),
  mockUseBranches: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: mockUsePathname,
  useSearchParams: mockUseSearchParams,
}));

vi.mock('@/hooks/queries/use-shadow-bom-deduction', () => ({
  useShadowBomDeductionSummary: mockUseShadowBomDeductionSummary,
  useShadowBomDeductionDetails: mockUseShadowBomDeductionDetails,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

/** KpiCard's NumberTicker doesn't resolve synchronously in jsdom — swap in a plain render (mirrors fraud-alert-management-panel.test.tsx). */
vi.mock('@/components/shared/charts/kpi-card', () => ({
  KpiCard: ({ title, value, isLoading }: { title: string; value: number; isLoading?: boolean }) => (
    <div>
      <span>{title}</span>
      <span>{isLoading ? 'loading' : value}</span>
    </div>
  ),
}));

/** Flat, always-rendered stand-in for the Radix Select (mirrors fraud-alert-management-panel.test.tsx). */
vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({});

  function Select({
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: React.ReactNode;
  }) {
    return <SelectContext.Provider value={{ onValueChange }}>{children}</SelectContext.Provider>;
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
  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    const ctx = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => ctx.onValueChange?.(value)}>
        {children}
      </button>
    );
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

function branch(overrides: Partial<BranchResponse> = {}): BranchResponse {
  return {
    id: 'branch-1',
    name: 'Main Branch',
    code: 'PC-MNL-001',
    address: '123 Rizal St',
    city: 'Manila',
    gpsLatitude: 14.5995,
    gpsLongitude: 120.9842,
    gpsRadiusMeters: 100,
    status: 'active',
    gcashQrUrl: null,
    gcashQrKey: null,
    activeSupervisorCount: 1,
    activeStaffCount: 5,
    currentStatusLabel: 'Open',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function branchListResponse(overrides: Partial<BranchListResponse> = {}): BranchListResponse {
  return { branches: [branch()], total: 1, page: 1, limit: 100, ...overrides };
}

function summary(overrides: Partial<ShadowBomDeductionSummary> = {}): ShadowBomDeductionSummary {
  return {
    total_compared: 10,
    match_count: 7,
    match_percentage: 70,
    counts_by_classification: { MATCH: 7, BOM_NOT_READY: 1, QUANTITY_MISMATCH: 1, ERROR: 1 },
    affected_product_variant_ids: ['variant-1'],
    affected_branch_ids: ['branch-1'],
    ...overrides,
  };
}

function detailRow(overrides: Partial<ShadowBomDeductionDetailsPage['rows'][number]> = {}) {
  return {
    id: 'row-1',
    transaction_id: 'txn-1',
    sale_line_id: 'line-1',
    branch_id: 'branch-1',
    product_variant_id: 'variant-1',
    legacy_calculation: [{ inventoryItemId: 'item-1', quantity: 1 }],
    bom_calculation: [{ inventoryItemId: 'item-1', quantity: 1 }],
    classification: 'MATCH' as const,
    error_details: null,
    compared_at: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

function detailsPage(overrides: Partial<ShadowBomDeductionDetailsPage> = {}): ShadowBomDeductionDetailsPage {
  return { rows: [detailRow()], page: 1, page_size: 25, total: 1, ...overrides };
}

beforeEach(() => {
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  mockUseBranches.mockReturnValue({ data: branchListResponse(), isLoading: false });
  mockUseShadowBomDeductionSummary.mockReturnValue({ data: summary(), isLoading: false, isError: false, refetch: vi.fn() });
  mockUseShadowBomDeductionDetails.mockReturnValue({ data: detailsPage(), isLoading: false, isError: false, refetch: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ShadowBomDeductionReport', () => {
  it('renders summary KPI cards derived from the summary endpoint', () => {
    render(<ShadowBomDeductionReport />);

    expect(screen.getByText('Total Compared')).toBeInTheDocument();
    expect(screen.getByText('Match Count')).toBeInTheDocument();
    expect(screen.getByText('Match %')).toBeInTheDocument();
    expect(screen.getByText('BOM Not Ready', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Total Mismatches')).toBeInTheDocument();
    expect(screen.getByText('Errors', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('10', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('7', { selector: 'span' })).toBeInTheDocument();
  });

  it('renders the "no comparisons yet" empty state when there are no rows and no filters applied', () => {
    mockUseShadowBomDeductionDetails.mockReturnValue({
      data: detailsPage({ rows: [], total: 0 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ShadowBomDeductionReport />);

    expect(screen.getByText('No shadow comparisons yet')).toBeInTheDocument();
  });

  it('renders the "no matches" empty state with a clear-filters action when filters are applied', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('shadow_branch_id=branch-1'));
    mockUseShadowBomDeductionDetails.mockReturnValue({
      data: detailsPage({ rows: [], total: 0 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ShadowBomDeductionReport />);

    expect(screen.getByText('No comparisons match the current filters')).toBeInTheDocument();
    const clearButtons = screen.getAllByRole('button', { name: 'Clear filters' });
    fireEvent.click(clearButtons[0] as HTMLElement);
    expect(mockPush).toHaveBeenCalledWith('/admin/shadow-bom-deduction', { scroll: false });
  });

  it('renders DataTable rows with a classification badge when comparisons exist', () => {
    mockUseShadowBomDeductionDetails.mockReturnValue({
      data: detailsPage({ rows: [detailRow({ classification: 'QUANTITY_MISMATCH' })] }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ShadowBomDeductionReport />);

    const table = screen.getByRole('table');
    expect(within(table).getByText('txn-1')).toBeInTheDocument();
    expect(within(table).getByText('Quantity Mismatch')).toBeInTheDocument();
  });

  it('shows an error state with retry for a failed details fetch', () => {
    const refetch = vi.fn();
    mockUseShadowBomDeductionDetails.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });

    render(<ShadowBomDeductionReport />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows an error message with retry for a failed summary fetch', () => {
    const refetch = vi.fn();
    mockUseShadowBomDeductionSummary.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });

    render(<ShadowBomDeductionReport />);

    expect(screen.getByText('Failed to load the summary.')).toBeInTheDocument();
  });

  it('resets page to 1 when the branch filter changes', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('shadow_page=3'));

    render(<ShadowBomDeductionReport />);

    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));

    expect(mockPush).toHaveBeenCalledWith('/admin/shadow-bom-deduction?shadow_page=1&shadow_branch_id=branch-1', { scroll: false });
  });
});
