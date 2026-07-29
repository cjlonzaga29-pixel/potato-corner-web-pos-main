import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ShiftResponse } from '@potato-corner/shared';
import AdminDashboardPage from './page';

const {
  mockPush,
  mockUseShifts,
  mockUseShiftsRealtimeSync,
  mockUseTransactionsRealtimeSync,
  mockUseBranchRealtimeSync,
  mockUseSocketStore,
  mockUseAdminInventoryRollup,
  mockUseAdminInventoryRollupRealtimeSync,
  mockUseAllBranchStats,
  mockUseSelectedBranch,
  mockUseInventoryRealtimeSync,
  mockUseExpensesRealtimeSync,
  mockUseAttendanceRealtimeSync,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseShifts: vi.fn(),
  mockUseShiftsRealtimeSync: vi.fn(),
  mockUseTransactionsRealtimeSync: vi.fn(),
  mockUseBranchRealtimeSync: vi.fn(),
  mockUseSocketStore: vi.fn(),
  mockUseAdminInventoryRollup: vi.fn(),
  mockUseAdminInventoryRollupRealtimeSync: vi.fn(),
  mockUseAllBranchStats: vi.fn(),
  mockUseSelectedBranch: vi.fn(),
  mockUseInventoryRealtimeSync: vi.fn(),
  mockUseExpensesRealtimeSync: vi.fn(),
  mockUseAttendanceRealtimeSync: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => '/admin/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/use-selected-branch', () => ({
  useSelectedBranch: mockUseSelectedBranch,
}));

vi.mock('@/components/admin/branch-selector', () => ({
  BranchSelector: () => <div>Branch Selector</div>,
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
  useBranchRealtimeSync: mockUseBranchRealtimeSync,
  useAllBranchStats: mockUseAllBranchStats,
}));

vi.mock('@/components/monitoring/live-transaction-feed', () => ({
  LiveTransactionFeed: () => <div>Live Transaction Feed</div>,
}));

vi.mock('@/components/monitoring/active-cashiers-panel', () => ({
  ActiveCashiersPanel: () => <div>Active Cashiers Panel</div>,
}));

vi.mock('@/components/monitoring/live-alerts-stream', () => ({
  LiveAlertsStream: () => <div>Live Alerts Stream</div>,
}));

vi.mock('@/components/monitoring/branch-connection-panel', () => ({
  BranchConnectionPanel: () => <div>Branch Connection Panel</div>,
}));

vi.mock('@/hooks/queries/use-admin-inventory-rollup', () => ({
  useAdminInventoryRollup: mockUseAdminInventoryRollup,
  useAdminInventoryRollupRealtimeSync: mockUseAdminInventoryRollupRealtimeSync,
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryStockRealtimeSync: mockUseInventoryRealtimeSync,
}));

vi.mock('@/hooks/queries/use-expenses', () => ({
  useExpensesRealtimeSync: mockUseExpensesRealtimeSync,
}));

vi.mock('@/hooks/queries/use-attendance', () => ({
  useAttendanceRealtimeSync: mockUseAttendanceRealtimeSync,
}));

vi.mock('@/components/admin/dashboard-trends-section', () => ({
  DashboardTrendsSection: () => <div>Dashboard Trends Section</div>,
}));

vi.mock('@/components/admin/dashboard-attendance-overview', () => ({
  DashboardAttendanceOverview: () => <div>Dashboard Attendance Overview</div>,
}));

vi.mock('@/components/admin/dashboard-inventory-alerts', () => ({
  DashboardInventoryAlerts: () => <div>Dashboard Inventory Alerts</div>,
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
    maya_sales_total: 0,
    other_sales_total: 0,
    gross_sales_total: 0,
    transaction_count: 42,
    cash_sales_count: 30,
    gcash_sales_count: 12,
    maya_sales_count: 0,
    other_sales_count: 0,
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

interface ShiftsFilters {
  status?: 'active' | 'closed' | 'flagged';
  limit?: number;
}

function mockShiftsData(active: ShiftResponse[], flagged: ShiftResponse[], isLoading = false) {
  mockUseShifts.mockImplementation((filters: ShiftsFilters) => {
    if (filters.status === 'active') return { data: { shifts: active, total: active.length, page: 1, limit: 100 }, isLoading };
    if (filters.status === 'flagged') return { data: { shifts: flagged, total: flagged.length, page: 1, limit: 100 }, isLoading };
    return { data: undefined, isLoading };
  });
}

beforeEach(() => {
  mockSocketState({ isConnected: true, isReconnecting: false });
  mockUseShiftsRealtimeSync.mockReturnValue(undefined);
  mockUseTransactionsRealtimeSync.mockReturnValue(undefined);
  mockUseBranchRealtimeSync.mockReturnValue(undefined);
  mockShiftsData([], []);
  mockUseAllBranchStats.mockReturnValue({ data: [], isLoading: false, isError: false });
  mockUseSelectedBranch.mockReturnValue({
    selectedBranchId: 'all',
    setSelectedBranch: vi.fn(),
    availableBranches: [],
    allLabel: 'All Branches',
    isSingleBranchUser: false,
  });
  mockUseAdminInventoryRollup.mockReturnValue({
    data: {
      generated_at: '2026-07-21T00:00:00.000Z',
      branches: [],
      summary: {
        total_inventory_value: 0,
        total_active_inventory_items: 0,
        total_inventory_stock_rows: 0,
        total_low_stock_rows: 0,
        total_critical_stock_rows: 0,
        total_out_of_stock_rows: 0,
      },
    },
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

    render(<AdminDashboardPage />);

    expect(screen.getAllByText('loading').length).toBeGreaterThan(0);
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

  it('renders the flagged shifts count', () => {
    mockShiftsData([], [shift({ id: 's1', status: 'flagged' }), shift({ id: 's2', status: 'flagged' })]);
    render(<AdminDashboardPage />);
    expect(screen.getByText('Flagged Shifts')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders the attendance shortcut card linking to /admin/attendance', () => {
    render(<AdminDashboardPage />);
    expect(screen.getByText('Attendance').closest('a')).toHaveAttribute('href', '/admin/attendance');
  });

  it('renders the Live Activity section with the embedded monitoring panels', () => {
    render(<AdminDashboardPage />);
    expect(screen.getByText('Live Activity')).toBeInTheDocument();
    expect(screen.getByText('Live Transaction Feed')).toBeInTheDocument();
    expect(screen.getByText('Active Cashiers Panel')).toBeInTheDocument();
    expect(screen.getByText('Live Alerts Stream')).toBeInTheDocument();
    expect(screen.getByText('Branch Connection Panel')).toBeInTheDocument();
  });

  it('renders a green connection indicator when connected', () => {
    mockSocketState({ isConnected: true, isReconnecting: false });
    render(<AdminDashboardPage />);
    expect(screen.getByTitle('Connected').className).toContain('bg-success');
  });

  it('calls all realtime sync hooks on mount', () => {
    render(<AdminDashboardPage />);
    expect(mockUseShiftsRealtimeSync).toHaveBeenCalled();
    expect(mockUseTransactionsRealtimeSync).toHaveBeenCalled();
    expect(mockUseBranchRealtimeSync).toHaveBeenCalled();
  });

  it('aggregates Gross Sales, Expenses, and Net Profit across branches in "All Branches" mode', () => {
    mockUseAllBranchStats.mockReturnValue({
      data: [
        {
          branchId: 'b1',
          activeShiftsCount: 1,
          activeStaffCount: 2,
          todayRevenue: 1000,
          todayGrossSales: 1000,
          todayVat: 107.14,
          todayExpenses: 200,
          todayNetProfit: 692.86,
          todayTransactionCount: 5,
          lowStockIngredientCount: 0,
        },
        {
          branchId: 'b2',
          activeShiftsCount: 1,
          activeStaffCount: 3,
          todayRevenue: 500,
          todayGrossSales: 500,
          todayVat: 53.57,
          todayExpenses: 50,
          todayNetProfit: 396.43,
          todayTransactionCount: 2,
          lowStockIngredientCount: 0,
        },
      ],
      isLoading: false,
      isError: false,
    });

    render(<AdminDashboardPage />);

    expect(screen.getByText('Gross Sales')).toBeInTheDocument();
    expect(screen.getByText('₱1500')).toBeInTheDocument();
    expect(screen.getByText('Expenses')).toBeInTheDocument();
    expect(screen.getByText('₱250')).toBeInTheDocument();
    expect(screen.getByText('Net Profit')).toBeInTheDocument();
    expect(screen.getByText('₱1089.29')).toBeInTheDocument();
  });
});
