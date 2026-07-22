import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { BranchResponse, PriceOverrideResponse, ProductRequestResponse, ShiftResponse } from '@potato-corner/shared';
import AdminDashboardPage from './page';

const {
  mockPush,
  mockUseShifts,
  mockUseShiftsRealtimeSync,
  mockUseTransactionsRealtimeSync,
  mockUseBranches,
  mockUseBranchRealtimeSync,
  mockUseProductRequests,
  mockUseProductRequestRealtimeSync,
  mockUsePriceOverrides,
  mockUsePriceOverrideRealtimeSync,
  mockUseSocketStore,
  mockUseAdminInventoryRollup,
  mockUseAllBranchStats,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseShifts: vi.fn(),
  mockUseShiftsRealtimeSync: vi.fn(),
  mockUseTransactionsRealtimeSync: vi.fn(),
  mockUseBranches: vi.fn(),
  mockUseBranchRealtimeSync: vi.fn(),
  mockUseProductRequests: vi.fn(),
  mockUseProductRequestRealtimeSync: vi.fn(),
  mockUsePriceOverrides: vi.fn(),
  mockUsePriceOverrideRealtimeSync: vi.fn(),
  mockUseSocketStore: vi.fn(),
  mockUseAdminInventoryRollup: vi.fn(),
  mockUseAllBranchStats: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('@/stores/socket.store', () => ({
  useSocketStore: mockUseSocketStore,
}));

vi.mock('@/hooks/queries/use-shifts', () => ({
  useShifts: mockUseShifts,
  useShiftsRealtimeSync: mockUseShiftsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransactionsRealtimeSync: mockUseTransactionsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
  useBranchRealtimeSync: mockUseBranchRealtimeSync,
  useAllBranchStats: mockUseAllBranchStats,
}));

vi.mock('@/hooks/queries/use-product-requests', () => ({
  useProductRequests: mockUseProductRequests,
  useProductRequestRealtimeSync: mockUseProductRequestRealtimeSync,
}));

vi.mock('@/hooks/queries/use-price-overrides', () => ({
  usePriceOverrides: mockUsePriceOverrides,
  usePriceOverrideRealtimeSync: mockUsePriceOverrideRealtimeSync,
}));

vi.mock('@/hooks/queries/use-admin-inventory-rollup', () => ({
  useAdminInventoryRollup: mockUseAdminInventoryRollup,
}));

/**
 * KpiCard's NumberTicker animates via Framer Motion springs driven by
 * requestAnimationFrame, which never ticks synchronously in jsdom — the
 * real component would always show its startValue (0), not the actual
 * number. Swapping in a plain, synchronous render here (title/value/prefix
 * as text) lets tests verify the *computed* KPI values the page passes
 * down, matching the supervisor dashboard test's approach.
 */
vi.mock('@/components/shared/charts/kpi-card', () => ({
  KpiCard: ({ title, value, prefix, isLoading }: { title: string; value: number; prefix?: string; isLoading?: boolean }) => (
    <div>
      <span>{title}</span>
      <span>{isLoading ? 'loading' : `${prefix ?? ''}${Number.isInteger(value) ? value : value.toFixed(2)}`}</span>
    </div>
  ),
}));

interface SocketState {
  isConnected: boolean;
  isReconnecting: boolean;
}

function mockSocketState(state: SocketState) {
  mockUseSocketStore.mockImplementation((selector: (s: SocketState) => unknown) => selector(state));
}

function shift(overrides: Partial<ShiftResponse> = {}): ShiftResponse {
  return {
    id: 'shift-1',
    branch_id: 'branch-1',
    cashier_id: 'cashier-1234-5678',
    opened_by: 'supervisor-1',
    closed_by: null,
    status: 'active',
    opening_cash_amount: 1500,
    closing_cash_amount: null,
    expected_closing_cash: null,
    cash_variance: null,
    variance_approved: null,
    variance_explanation: null,
    variance_approved_by: null,
    variance_approval_reason: null,
    cash_sales_total: 3000,
    gcash_sales_total: 1500,
    transaction_count: 42,
    cash_sales_count: 30,
    gcash_sales_count: 12,
    voided_count: 0,
    refunded_count: 0,
    total_transaction_count: 42,
    total_discount_amount: 250.5,
    pwd_sc_transaction_count: 2,
    shift_notes: null,
    started_at: '2026-07-16T02:32:00.000Z',
    closed_at: null,
    ...overrides,
  };
}

function branch(overrides: Partial<BranchResponse> = {}): BranchResponse {
  return {
    id: 'branch-1',
    name: 'Manila Branch',
    code: 'PC-MNL-001',
    address: '123 Rizal Ave',
    city: 'Manila',
    gpsLatitude: 14.5995,
    gpsLongitude: 120.9842,
    gpsRadiusMeters: 100,
    status: 'active',
    gcashQrUrl: null,
    gcashQrKey: null,
    activeSupervisorCount: 1,
    activeStaffCount: 5,
    currentStatusLabel: 'Active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function productRequest(overrides: Partial<ProductRequestResponse> = {}): ProductRequestResponse {
  return {
    id: 'request-1',
    branch_id: 'branch-1',
    branch_name: 'Manila Branch',
    requested_by: 'user-1',
    requested_by_name: 'Juan Dela Cruz',
    proposed_name: 'Cheese Overload',
    proposed_description: null,
    proposed_category: null,
    proposed_variants: [],
    proposed_flavors: [],
    proposed_recipes: [],
    request_reason: 'Customer demand for a new flavor variant based on regional taste testing feedback.',
    status: 'pending',
    reviewed_by: null,
    reviewed_by_name: null,
    reviewed_at: null,
    review_notes: null,
    created_product_id: null,
    created_at: '2026-07-16T01:00:00.000Z',
    updated_at: '2026-07-16T01:00:00.000Z',
    ...overrides,
  };
}

function priceOverride(overrides: Partial<PriceOverrideResponse> = {}): PriceOverrideResponse {
  return {
    id: 'override-1',
    branch_id: 'branch-1',
    branch_name: 'Manila Branch',
    product_variant_id: 'variant-1',
    variant_name: 'Regular',
    product_name: 'Classic Potato',
    master_price: 65,
    requested_price: 75,
    status: 'pending',
    requested_by: 'user-1',
    requested_by_name: 'Juan Dela Cruz',
    request_reason: 'Local ingredient cost increase requires a branch-specific price adjustment.',
    reviewed_by: null,
    reviewed_by_name: null,
    reviewed_at: null,
    review_notes: null,
    effective_from: null,
    created_at: '2026-07-16T01:00:00.000Z',
    updated_at: '2026-07-16T01:00:00.000Z',
    ...overrides,
  };
}

interface ShiftsFilters {
  status?: 'active' | 'closed' | 'flagged';
  limit?: number;
}

interface RequestFilters {
  status?: string;
  limit?: number;
}

function mockShiftsData(active: ShiftResponse[], flagged: ShiftResponse[], isLoading = false) {
  mockUseShifts.mockImplementation((filters: ShiftsFilters) => {
    if (filters.status === 'active') return { data: { shifts: active, total: active.length, page: 1, limit: 100 }, isLoading };
    if (filters.status === 'flagged') return { data: { shifts: flagged, total: flagged.length, page: 1, limit: 100 }, isLoading };
    return { data: undefined, isLoading };
  });
}

function mockProductRequestsData(list: ProductRequestResponse[], total: number, isLoading = false) {
  mockUseProductRequests.mockImplementation((filters: RequestFilters) => {
    if (filters.limit === 1) return { data: { requests: [], total, page: 1, limit: 1 }, isLoading };
    return { data: { requests: list, total, page: 1, limit: 5 }, isLoading };
  });
}

function mockPriceOverridesData(list: PriceOverrideResponse[], total: number, isLoading = false) {
  mockUsePriceOverrides.mockImplementation((filters: RequestFilters) => {
    if (filters.limit === 1) return { data: { overrides: [], total, page: 1, limit: 1 }, isLoading };
    return { data: { overrides: list, total, page: 1, limit: 5 }, isLoading };
  });
}

beforeEach(() => {
  mockSocketState({ isConnected: true, isReconnecting: false });
  mockUseShiftsRealtimeSync.mockReturnValue(undefined);
  mockUseTransactionsRealtimeSync.mockReturnValue(undefined);
  mockUseBranchRealtimeSync.mockReturnValue(undefined);
  mockUseProductRequestRealtimeSync.mockReturnValue(undefined);
  mockUsePriceOverrideRealtimeSync.mockReturnValue(undefined);
  mockShiftsData([], []);
  mockProductRequestsData([], 0);
  mockPriceOverridesData([], 0);
  mockUseBranches.mockReturnValue({ data: { branches: [], total: 0, page: 1, limit: 100 }, isLoading: false });
  mockUseAllBranchStats.mockReturnValue({ data: [], isLoading: false, isError: false });
  mockUseAdminInventoryRollup.mockReturnValue({
    data: { report_type: 'INVENTORY_VALUATION', computed_at: '2026-07-21T00:00:00.000Z', branch_id: null, data: [] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AdminDashboardPage', () => {
  it('renders loading skeletons for all panels when every query is loading', () => {
    mockShiftsData([], [], true);
    mockProductRequestsData([], 0, true);
    mockPriceOverridesData([], 0, true);
    mockUseBranches.mockReturnValue({ data: undefined, isLoading: true });

    const { container } = render(<AdminDashboardPage />);

    expect(screen.getAllByText('loading').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders the active shifts count from data.total', () => {
    mockShiftsData([shift({ id: 's1' }), shift({ id: 's2' })], []);
    render(<AdminDashboardPage />);
    expect(screen.getByText('Active Shifts')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders live revenue as the sum of cash_sales_total + gcash_sales_total across active shifts', () => {
    mockShiftsData(
      [
        shift({ id: 's1', cash_sales_total: 3000, gcash_sales_total: 1500 }),
        shift({ id: 's2', cash_sales_total: 2000, gcash_sales_total: 500.5 }),
      ],
      [],
    );
    render(<AdminDashboardPage />);
    expect(screen.getByText('₱7000.50')).toBeInTheDocument();
  });

  it('renders pending approvals as the sum of product request total and price override total', () => {
    mockProductRequestsData([], 3);
    mockPriceOverridesData([], 2);
    render(<AdminDashboardPage />);
    expect(screen.getByText('Pending Approvals')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('renders the flagged shifts count', () => {
    mockShiftsData([], [shift({ id: 's1', status: 'flagged' }), shift({ id: 's2', status: 'flagged' })]);
    render(<AdminDashboardPage />);
    expect(screen.getByText('Flagged Shifts')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders the branch grid with branch names and status badges', () => {
    mockUseBranches.mockReturnValue({
      data: { branches: [branch({ id: 'b1', name: 'Manila Branch', status: 'active' })], total: 1, page: 1, limit: 100 },
      isLoading: false,
    });
    render(<AdminDashboardPage />);
    expect(screen.getByText('Manila Branch')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders a flagged warning on a branch card when the branch has a flagged shift', () => {
    mockUseBranches.mockReturnValue({
      data: { branches: [branch({ id: 'b1', name: 'Manila Branch' })], total: 1, page: 1, limit: 100 },
      isLoading: false,
    });
    mockShiftsData([], [shift({ id: 's1', branch_id: 'b1', status: 'flagged' })]);
    render(<AdminDashboardPage />);
    expect(screen.getByText('Shift flagged')).toBeInTheDocument();
  });

  it('renders the pending product requests list with branch_name and proposed_name', () => {
    mockProductRequestsData([productRequest({ branch_name: 'Manila Branch', proposed_name: 'Cheese Overload' })], 1);
    render(<AdminDashboardPage />);
    expect(screen.getByText('Cheese Overload')).toBeInTheDocument();
    expect(screen.getByText(/Manila Branch/)).toBeInTheDocument();
  });

  it('renders the pending price overrides list with product_name and price values', () => {
    mockPriceOverridesData([priceOverride({ product_name: 'Classic Potato', master_price: 65, requested_price: 75 })], 1);
    render(<AdminDashboardPage />);
    expect(screen.getByText(/Classic Potato/)).toBeInTheDocument();
    expect(screen.getByText('₱65.00')).toBeInTheDocument();
    expect(screen.getByText('₱75.00')).toBeInTheDocument();
  });

  it('renders "No pending product requests" empty state when the list is empty', () => {
    mockProductRequestsData([], 0);
    render(<AdminDashboardPage />);
    expect(screen.getByText('No pending product requests')).toBeInTheDocument();
  });

  it('renders "No pending price overrides" empty state when the list is empty', () => {
    mockPriceOverridesData([], 0);
    render(<AdminDashboardPage />);
    expect(screen.getByText('No pending price overrides')).toBeInTheDocument();
  });

  it('renders shortcut cards linking to /admin/branches and /admin/attendance', () => {
    render(<AdminDashboardPage />);
    expect(screen.getByText('Inventory Alerts').closest('a')).toHaveAttribute('href', '/admin/branches');
    expect(screen.getByText('Attendance').closest('a')).toHaveAttribute('href', '/admin/attendance');
  });

  it('renders a green connection indicator when connected', () => {
    mockSocketState({ isConnected: true, isReconnecting: false });
    render(<AdminDashboardPage />);
    expect(screen.getByTitle('Connected').className).toContain('bg-green-500');
  });

  it('calls all 5 realtime sync hooks on mount', () => {
    render(<AdminDashboardPage />);
    expect(mockUseShiftsRealtimeSync).toHaveBeenCalled();
    expect(mockUseTransactionsRealtimeSync).toHaveBeenCalled();
    expect(mockUseProductRequestRealtimeSync).toHaveBeenCalled();
    expect(mockUsePriceOverrideRealtimeSync).toHaveBeenCalled();
    expect(mockUseBranchRealtimeSync).toHaveBeenCalled();
  });
});
