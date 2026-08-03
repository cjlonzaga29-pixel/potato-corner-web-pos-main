import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import AdminDashboardPage from './page';

const {
  mockUseShiftsRealtimeSync,
  mockUseTransactionsRealtimeSync,
  mockUseBranchRealtimeSync,
  mockUseSocketStore,
  mockUseAllBranchStats,
  mockUseBranches,
  mockUseSelectedBranch,
  mockUseInventoryRealtimeSync,
  mockUseDashboardSalesTrendReport,
} = vi.hoisted(() => ({
  mockUseShiftsRealtimeSync: vi.fn(),
  mockUseTransactionsRealtimeSync: vi.fn(),
  mockUseBranchRealtimeSync: vi.fn(),
  mockUseSocketStore: vi.fn(),
  mockUseAllBranchStats: vi.fn(),
  mockUseBranches: vi.fn(),
  mockUseSelectedBranch: vi.fn(),
  mockUseInventoryRealtimeSync: vi.fn(),
  mockUseDashboardSalesTrendReport: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/use-selected-branch', () => ({
  useSelectedBranch: mockUseSelectedBranch,
}));

vi.mock('@/components/admin/branch-selector', () => ({
  BranchSelector: () => <div>Branch Selector</div>,
}));

vi.mock('@/components/shared/dashboard/sales-analytics-section', () => ({
  SalesAnalyticsSection: () => <div>Sales Analytics Section</div>,
}));

vi.mock('@/components/admin/dashboard-branch-performance-table', () => ({
  DashboardBranchPerformanceTable: () => <div>Branch Performance Table</div>,
}));

vi.mock('@/components/admin/dashboard-low-stock-summary', () => ({
  DashboardLowStockSummary: () => <div>Low Stock Summary</div>,
}));

vi.mock('@/components/admin/dashboard-recent-activity', () => ({
  DashboardRecentActivity: () => <div>Recent Activity</div>,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('@/stores/socket.store', () => ({
  useSocketStore: mockUseSocketStore,
}));

vi.mock('@/hooks/queries/use-shifts', () => ({
  useShiftsRealtimeSync: mockUseShiftsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransactionsRealtimeSync: mockUseTransactionsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranchRealtimeSync: mockUseBranchRealtimeSync,
  useAllBranchStats: mockUseAllBranchStats,
  useBranches: mockUseBranches,
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryStockRealtimeSync: mockUseInventoryRealtimeSync,
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useDashboardSalesTrendReport: mockUseDashboardSalesTrendReport,
  useInventoryAnalyticsRealtimeSync: vi.fn(),
}));

vi.mock('@/hooks/queries/use-expenses', () => ({
  useExpensesRealtimeSync: vi.fn(),
}));

vi.mock('@/hooks/queries/use-attendance', () => ({
  useAttendanceRealtimeSync: vi.fn(),
}));

/**
 * KpiCard's NumberTicker animates via Framer Motion springs driven by
 * requestAnimationFrame, which never ticks synchronously in jsdom — the
 * real component would always show its startValue (0), not the actual
 * number. Swapping in a plain, synchronous render here (title/value/prefix
 * as text) lets tests verify the *computed* KPI values the page passes
 * down.
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

function branchStat(overrides: Record<string, unknown> = {}) {
  return {
    branchId: 'b1',
    activeShiftsCount: 0,
    activeStaffCount: 0,
    staffTimedInCount: 0,
    todayGrossSales: 0,
    todayDiscountTotal: 0,
    todayRefundTotal: 0,
    todayNetSales: 0,
    todayVat: 0,
    todayCogs: 0,
    todayGrossProfit: 0,
    todayExpenses: 0,
    todayNetProfit: 0,
    isNetProfitEstimated: false,
    missingCostItemCount: 0,
    paymentBreakdown: {
      cash: { total: 0, count: 0 },
      gcash: { total: 0, count: 0 },
      maya: { total: 0, count: 0 },
      other: { total: 0, count: 0 },
    },
    todayTransactionCount: 0,
    lowStockIngredientCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockSocketState({ isConnected: true, isReconnecting: false });
  mockUseShiftsRealtimeSync.mockReturnValue(undefined);
  mockUseTransactionsRealtimeSync.mockReturnValue(undefined);
  mockUseBranchRealtimeSync.mockReturnValue(undefined);
  mockUseInventoryRealtimeSync.mockReturnValue(undefined);
  mockUseAllBranchStats.mockReturnValue({ data: [], isLoading: false, isError: false });
  mockUseBranches.mockReturnValue({ data: { branches: [], total: 0, page: 1, limit: 500 }, isLoading: false, isError: false });
  mockUseDashboardSalesTrendReport.mockReturnValue({ data: { data: [] }, isLoading: false, isError: false });
  mockUseSelectedBranch.mockReturnValue({
    selectedBranchId: 'all',
    setSelectedBranch: vi.fn(),
    availableBranches: [],
    allLabel: 'All Branches',
    isSingleBranchUser: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AdminDashboardPage', () => {
  it('renders Gross Sales aggregated across branch stats', () => {
    mockUseAllBranchStats.mockReturnValue({
      data: [branchStat({ branchId: 'b1', todayGrossSales: 1000 }), branchStat({ branchId: 'b2', todayGrossSales: 500 })],
      isLoading: false,
      isError: false,
    });

    render(<AdminDashboardPage />);

    expect(screen.getByText('Gross Sales')).toBeInTheDocument();
    expect(screen.getByText('₱1500')).toBeInTheDocument();
  });

  it('renders Gross Sales — This Month summed from the sales trend report', () => {
    mockUseDashboardSalesTrendReport.mockReturnValue({
      data: { data: [{ report_date: '2026-07-01', gross_sales: 10000 }, { report_date: '2026-07-15', gross_sales: 5000 }] },
      isLoading: false,
      isError: false,
    });

    render(<AdminDashboardPage />);

    expect(screen.getByText('Gross Sales — This Month')).toBeInTheDocument();
    expect(screen.getByText('₱15000')).toBeInTheDocument();
  });

  it('Gross Sales (today) and Gross Sales — This Month use different date ranges and can differ', () => {
    mockUseAllBranchStats.mockReturnValue({
      data: [branchStat({ branchId: 'b1', todayGrossSales: 1500 })],
      isLoading: false,
      isError: false,
    });
    mockUseDashboardSalesTrendReport.mockReturnValue({
      data: { data: [{ report_date: '2026-07-01', gross_sales: 10000 }, { report_date: '2026-07-31', gross_sales: 1500 }] },
      isLoading: false,
      isError: false,
    });

    render(<AdminDashboardPage />);

    expect(screen.getByText('Gross Sales')).toBeInTheDocument();
    expect(screen.getByText('Gross Sales — This Month')).toBeInTheDocument();
    // Today reflects only today's branch stats (1500); this month sums the whole month (11500) — distinct periods, distinct values.
    expect(screen.getByText('₱1500')).toBeInTheDocument();
    expect(screen.getByText('₱11500')).toBeInTheDocument();
  });

  it('renders Net Sales, Transactions, and Profit Today aggregated across branch stats', () => {
    mockUseAllBranchStats.mockReturnValue({
      data: [
        branchStat({ branchId: 'b1', todayNetSales: 900, todayTransactionCount: 10, todayNetProfit: 300 }),
        branchStat({ branchId: 'b2', todayNetSales: 400, todayTransactionCount: 5, todayNetProfit: 150 }),
      ],
      isLoading: false,
      isError: false,
    });

    render(<AdminDashboardPage />);

    expect(screen.getByText('Net Sales')).toBeInTheDocument();
    expect(screen.getByText('₱1300')).toBeInTheDocument();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('Profit Today')).toBeInTheDocument();
    expect(screen.getByText('₱450')).toBeInTheDocument();
  });

  it('labels Profit Today as estimated when any branch has estimated cost data', () => {
    mockUseAllBranchStats.mockReturnValue({
      data: [branchStat({ branchId: 'b1', isNetProfitEstimated: true, missingCostItemCount: 2 })],
      isLoading: false,
      isError: false,
    });

    render(<AdminDashboardPage />);

    expect(screen.getByText('Estimated Profit Today')).toBeInTheDocument();
  });

  it('renders the payment breakdown aggregated across branches', () => {
    mockUseAllBranchStats.mockReturnValue({
      data: [
        branchStat({
          branchId: 'b1',
          paymentBreakdown: {
            cash: { total: 1000, count: 1 },
            gcash: { total: 200, count: 1 },
            maya: { total: 50, count: 1 },
            other: { total: 0, count: 0 },
          },
        }),
      ],
      isLoading: false,
      isError: false,
    });

    render(<AdminDashboardPage />);

    expect(screen.getByText('Payment Breakdown (Today)')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('GCash')).toBeInTheDocument();
    expect(screen.getByText('PayMaya')).toBeInTheDocument();
  });

  it('renders the low stock total and a View Inventory link', () => {
    mockUseAllBranchStats.mockReturnValue({
      data: [branchStat({ branchId: 'b1', lowStockIngredientCount: 3 })],
      isLoading: false,
      isError: false,
    });

    render(<AdminDashboardPage />);

    expect(screen.getByText('Low Stock Inventory')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('View Inventory').closest('a')).toHaveAttribute('href', '/admin/inventory');
  });

  it('renders active vs. inactive branch counts', () => {
    mockUseBranches.mockReturnValue({
      data: {
        branches: [
          { id: '1', status: 'active' },
          { id: '2', status: 'active' },
          { id: '3', status: 'inactive' },
        ],
        total: 3,
        page: 1,
        limit: 500,
      },
      isLoading: false,
      isError: false,
    });

    render(<AdminDashboardPage />);

    expect(screen.getByText('Active Branches')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders a labeled Connected badge (not color-only) when connected', () => {
    mockSocketState({ isConnected: true, isReconnecting: false });
    render(<AdminDashboardPage />);
    expect(screen.getByText('Connected').closest('div')?.className).toContain('bg-success');
  });

  it('renders a labeled Disconnected badge when the socket drops', () => {
    mockSocketState({ isConnected: false, isReconnecting: false });
    render(<AdminDashboardPage />);
    expect(screen.getByText('Disconnected').closest('div')?.className).toContain('bg-destructive');
  });

  it('calls all realtime sync hooks on mount', () => {
    render(<AdminDashboardPage />);
    expect(mockUseShiftsRealtimeSync).toHaveBeenCalled();
    expect(mockUseTransactionsRealtimeSync).toHaveBeenCalled();
    expect(mockUseBranchRealtimeSync).toHaveBeenCalled();
    expect(mockUseInventoryRealtimeSync).toHaveBeenCalled();
  });
});
