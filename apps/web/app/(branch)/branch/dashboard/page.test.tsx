import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import BranchDashboardPage from './page';

const {
  mockPush,
  mockUseAuth,
  mockUseSocketStore,
  mockUseBranch,
  mockUseAllBranchStats,
  mockUseCurrentShift,
  mockUseShiftsRealtimeSync,
  mockUseTransactions,
  mockUseTransactionsRealtimeSync,
  mockUseBranchInventoryStockAlerts,
  mockUseInventoryStockRealtimeSync,
  mockUseAttendanceByBranch,
  mockUseAttendanceRealtimeSync,
  mockUseDashboardSalesTrendReport,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseAuth: vi.fn(),
  mockUseSocketStore: vi.fn(),
  mockUseBranch: vi.fn(),
  mockUseAllBranchStats: vi.fn(),
  mockUseCurrentShift: vi.fn(),
  mockUseShiftsRealtimeSync: vi.fn(),
  mockUseTransactions: vi.fn(),
  mockUseTransactionsRealtimeSync: vi.fn(),
  mockUseBranchInventoryStockAlerts: vi.fn(),
  mockUseInventoryStockRealtimeSync: vi.fn(),
  mockUseAttendanceByBranch: vi.fn(),
  mockUseAttendanceRealtimeSync: vi.fn(),
  mockUseDashboardSalesTrendReport: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/stores/socket.store', () => ({
  useSocketStore: mockUseSocketStore,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranch: mockUseBranch,
  useAllBranchStats: mockUseAllBranchStats,
}));

vi.mock('@/hooks/queries/use-shifts', () => ({
  useCurrentShift: mockUseCurrentShift,
  useShiftsRealtimeSync: mockUseShiftsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransactions: mockUseTransactions,
  useTransactionsRealtimeSync: mockUseTransactionsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useBranchInventoryStockAlerts: mockUseBranchInventoryStockAlerts,
  useInventoryStockRealtimeSync: mockUseInventoryStockRealtimeSync,
}));

vi.mock('@/hooks/queries/use-attendance', () => ({
  useAttendanceByBranch: mockUseAttendanceByBranch,
  useAttendanceRealtimeSync: mockUseAttendanceRealtimeSync,
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useDashboardSalesTrendReport: mockUseDashboardSalesTrendReport,
  useInventoryAnalyticsRealtimeSync: vi.fn(),
}));

vi.mock('@/hooks/queries/use-expenses', () => ({
  useExpensesRealtimeSync: vi.fn(),
}));

vi.mock('@/components/shared/dashboard/sales-analytics-section', () => ({
  SalesAnalyticsSection: () => <div>Sales Analytics Section</div>,
}));

vi.mock('@/components/shared/dashboard/top-products-panel', () => ({
  TopProductsPanel: () => <div>Top Products Panel</div>,
}));

vi.mock('@/components/shared/dashboard/inventory-consumption-panel', () => ({
  InventoryConsumptionPanel: () => <div>Inventory Consumption Panel</div>,
}));

/** Same rationale as the supervisor dashboard test: NumberTicker never settles synchronously in jsdom. */
vi.mock('@/components/shared/charts/kpi-card', () => ({
  KpiCard: ({
    title,
    value,
    prefix,
    isLoading,
    tooltip,
  }: {
    title: string;
    value: number;
    prefix?: string;
    isLoading?: boolean;
    tooltip?: string;
  }) => (
    <div title={tooltip}>
      <span>{title}</span>
      <span>{isLoading ? 'loading' : `${prefix ?? ''}${Number.isInteger(value) ? value : value.toFixed(2)}`}</span>
    </div>
  ),
}));

function statsRow(overrides: Record<string, unknown> = {}) {
  return {
    branchId: 'branch-1',
    activeShiftsCount: 1,
    activeStaffCount: 3,
    staffTimedInCount: 2,
    todayGrossSales: 1200,
    todayDiscountTotal: 0,
    todayRefundTotal: 0,
    todayNetSales: 1000,
    todayVat: 107.14,
    todayCogs: 200,
    todayGrossProfit: 800,
    todayExpenses: 150,
    todayNetProfit: 650,
    isNetProfitEstimated: false,
    missingCostItemCount: 0,
    paymentBreakdown: {
      cash: { total: 700, count: 5 },
      gcash: { total: 200, count: 2 },
      maya: { total: 100, count: 1 },
      other: { total: 0, count: 0 },
    },
    todayTransactionCount: 8,
    lowStockIngredientCount: 0,
    ...overrides,
  };
}

function setup(stats: ReturnType<typeof statsRow> | undefined, isLoadingStats = false) {
  mockUseAuth.mockReturnValue({ user: { branchIds: ['branch-1'] } });
  mockUseSocketStore.mockImplementation((selector: (s: { isConnected: boolean; isReconnecting: boolean }) => unknown) =>
    selector({ isConnected: true, isReconnecting: false }),
  );
  mockUseBranch.mockReturnValue({ data: { id: 'branch-1', name: 'Manila Branch' } });
  mockUseAllBranchStats.mockReturnValue({ data: stats ? [stats] : undefined, isLoading: isLoadingStats });
  mockUseCurrentShift.mockReturnValue({ data: undefined, isLoading: false });
  mockUseTransactions.mockReturnValue({ data: { transactions: [] }, isLoading: false });
  mockUseBranchInventoryStockAlerts.mockReturnValue({ data: { alerts: [] }, isLoading: false });
  mockUseAttendanceByBranch.mockReturnValue({ data: { records: [] }, isLoading: false });
  mockUseDashboardSalesTrendReport.mockReturnValue({ data: { data: [] }, isLoading: false });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BranchDashboardPage', () => {
  it('renders Net Sales, Net Profit, and Staff Timed In from the branch stats row', () => {
    setup(statsRow());
    render(<BranchDashboardPage />);

    expect(screen.getByText('Net Sales')).toBeInTheDocument();
    expect(screen.getByText('₱1000')).toBeInTheDocument();
    expect(screen.getByText('Net Profit')).toBeInTheDocument();
    expect(screen.getByText('₱650')).toBeInTheDocument();
    expect(screen.getByText('Staff Timed In')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('labels the profit card "Estimated Net Profit" and explains why in the tooltip when cost data is missing', () => {
    setup(statsRow({ isNetProfitEstimated: true, missingCostItemCount: 4 }));
    render(<BranchDashboardPage />);

    expect(screen.getByText('Estimated Net Profit')).toBeInTheDocument();
    expect(screen.queryByText('Net Profit')).not.toBeInTheDocument();
    const card = screen.getByText('Estimated Net Profit').closest('div');
    expect(card).toHaveAttribute('title', expect.stringContaining('missing for 4 sold item'));
  });

  it('renders the per-method payment collections breakdown', () => {
    setup(statsRow());
    render(<BranchDashboardPage />);

    expect(screen.getByText('Payment Collections Today')).toBeInTheDocument();
    expect(screen.getByText('₱700.00')).toBeInTheDocument();
    expect(screen.getByText('5 txns')).toBeInTheDocument();
    expect(screen.getByText('₱200.00')).toBeInTheDocument();
    expect(screen.getByText('₱100.00')).toBeInTheDocument();
  });

  it('shows the empty state when the staff account has no assigned branch', () => {
    mockUseAuth.mockReturnValue({ user: { branchIds: [] } });
    mockUseSocketStore.mockImplementation((selector: (s: { isConnected: boolean; isReconnecting: boolean }) => unknown) =>
      selector({ isConnected: true, isReconnecting: false }),
    );
    mockUseBranch.mockReturnValue({ data: undefined });
    mockUseAllBranchStats.mockReturnValue({ data: undefined, isLoading: false });
    mockUseCurrentShift.mockReturnValue({ data: undefined, isLoading: false });
    mockUseTransactions.mockReturnValue({ data: undefined, isLoading: false });
    mockUseBranchInventoryStockAlerts.mockReturnValue({ data: undefined, isLoading: false });
    mockUseAttendanceByBranch.mockReturnValue({ data: undefined, isLoading: false });
    mockUseDashboardSalesTrendReport.mockReturnValue({ data: undefined, isLoading: false });

    render(<BranchDashboardPage />);

    expect(screen.getByText('No branch assigned')).toBeInTheDocument();
  });

  it('renders Daily Gross Sales from branch day-stats and Monthly Gross Sales summed from the sales trend report', () => {
    setup(statsRow({ todayGrossSales: 1500 }));
    mockUseDashboardSalesTrendReport.mockReturnValue({
      data: { data: [{ gross_sales: 8000 }, { gross_sales: 3500 }] },
      isLoading: false,
    });
    render(<BranchDashboardPage />);

    expect(screen.getByText('Daily Gross Sales')).toBeInTheDocument();
    expect(screen.getByText('₱1500')).toBeInTheDocument();
    expect(screen.getByText('Monthly Gross Sales')).toBeInTheDocument();
    expect(screen.getByText('₱11500')).toBeInTheDocument();
  });
});
