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
  mockUseDashboardSalesTrendReport.mockReturnValue({ data: { data: [] }, isLoading: false });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BranchDashboardPage', () => {
  it("renders Today's Expenses and Staff Clocked In from the branch stats row", () => {
    setup(statsRow({ todayExpenses: 175 }));
    render(<BranchDashboardPage />);

    expect(screen.getByText("Today's Expenses")).toBeInTheDocument();
    expect(screen.getByText('₱175')).toBeInTheDocument();
    expect(screen.getByText('Staff Clocked In')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('never renders Net Sales or (Estimated) Profit — removed in TASK 165', () => {
    setup(statsRow({ isNetProfitEstimated: true, missingCostItemCount: 4 }));
    render(<BranchDashboardPage />);

    expect(screen.queryByText('Net Sales Today')).not.toBeInTheDocument();
    expect(screen.queryByText(/Profit/)).not.toBeInTheDocument();
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
    mockUseDashboardSalesTrendReport.mockReturnValue({ data: undefined, isLoading: false });

    render(<BranchDashboardPage />);

    expect(screen.getByText('No branch assigned')).toBeInTheDocument();
  });

  it('renders Gross Sales Today from branch day-stats and Gross Sales This Month summed from the sales trend report', () => {
    setup(statsRow({ todayGrossSales: 1500 }));
    mockUseDashboardSalesTrendReport.mockReturnValue({
      data: { data: [{ gross_sales: 8000 }, { gross_sales: 3500 }] },
      isLoading: false,
    });
    render(<BranchDashboardPage />);

    expect(screen.getByText('Gross Sales Today')).toBeInTheDocument();
    expect(screen.getByText('₱1500')).toBeInTheDocument();
    expect(screen.getByText('Gross Sales This Month')).toBeInTheDocument();
    expect(screen.getByText('₱11500')).toBeInTheDocument();
  });

  it('renders the compact operational status cards for low stock and inventory alerts', () => {
    setup(statsRow({ lowStockIngredientCount: 3 }));
    mockUseBranchInventoryStockAlerts.mockReturnValue({
      data: { alerts: [{ inventory_item_id: '1' }, { inventory_item_id: '2' }, { inventory_item_id: '3' }, { inventory_item_id: '4' }, { inventory_item_id: '5' }] },
      isLoading: false,
    });
    render(<BranchDashboardPage />);

    expect(screen.getByText('Low Stock Items')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Inventory Alerts')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('renders the simplified quick actions including Stock Adjustment', () => {
    setup(statsRow());
    render(<BranchDashboardPage />);

    expect(screen.getByText('Open POS')).toBeInTheDocument();
    expect(screen.getByText('Receive Stock')).toBeInTheDocument();
    expect(screen.getByText('Stock Adjustment')).toBeInTheDocument();
    expect(screen.getByText('Log Expense')).toBeInTheDocument();
  });
});
