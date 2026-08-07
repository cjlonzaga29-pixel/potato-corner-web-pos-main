import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AttendanceResponse, InventoryStockAlert, TransactionResponse } from '@potato-corner/shared';
import SupervisorDashboardPage from './page';

const {
  mockPush,
  mockUseShiftsRealtimeSync,
  mockUseTransactions,
  mockUseTransactionsRealtimeSync,
  mockUseBranchInventoryAlerts,
  mockUseInventoryRealtimeSync,
  mockUseAttendanceByBranch,
  mockUseAttendanceRealtimeSync,
  mockUseBranchStore,
  mockUseSocketStore,
  mockUseBranches,
  mockUseAllBranchStats,
  mockUseDashboardSalesTrendReport,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseShiftsRealtimeSync: vi.fn(),
  mockUseTransactions: vi.fn(),
  mockUseTransactionsRealtimeSync: vi.fn(),
  mockUseBranchInventoryAlerts: vi.fn(),
  mockUseInventoryRealtimeSync: vi.fn(),
  mockUseAttendanceByBranch: vi.fn(),
  mockUseAttendanceRealtimeSync: vi.fn(),
  mockUseBranchStore: vi.fn(),
  mockUseSocketStore: vi.fn(),
  mockUseBranches: vi.fn(),
  mockUseAllBranchStats: vi.fn(),
  mockUseDashboardSalesTrendReport: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/stores/socket.store', () => ({
  useSocketStore: mockUseSocketStore,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
  useAllBranchStats: mockUseAllBranchStats,
}));

vi.mock('@/hooks/queries/use-shifts', () => ({
  useShiftsRealtimeSync: mockUseShiftsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransactions: mockUseTransactions,
  useTransactionsRealtimeSync: mockUseTransactionsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useBranchInventoryStockAlerts: mockUseBranchInventoryAlerts,
  useInventoryStockRealtimeSync: mockUseInventoryRealtimeSync,
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

/**
 * KpiCard's NumberTicker animates via Framer Motion springs driven by
 * requestAnimationFrame, which never ticks synchronously in jsdom — the
 * real component would always show its startValue (0), not the actual
 * number. Swapping in a plain, synchronous render here (title/value/prefix
 * as text) lets tests verify the *computed* KPI values the page passes
 * down, while the real KpiCard (already covered by its own usage
 * elsewhere) is untouched in production.
 */
vi.mock('@/components/shared/charts/kpi-card', () => ({
  KpiCard: ({ title, value, prefix, isLoading }: { title: string; value: number; prefix?: string; isLoading?: boolean }) => (
    <div>
      <span>{title}</span>
      <span>{isLoading ? 'loading' : `${prefix ?? ''}${Number.isInteger(value) ? value : value.toFixed(2)}`}</span>
    </div>
  ),
}));

interface BranchState {
  activeBranchId: string | null;
  activeBranch: { id: string; name: string } | null;
}

interface SocketState {
  isConnected: boolean;
  isReconnecting: boolean;
}

function mockBranchState(state: BranchState) {
  mockUseBranchStore.mockImplementation((selector: (s: BranchState) => unknown) => selector(state));
}

function mockSocketState(state: SocketState) {
  mockUseSocketStore.mockImplementation((selector: (s: SocketState) => unknown) => selector(state));
}

interface BranchStatsOverview {
  branchId: string;
  todayGrossSales: number;
  todayTransactionCount: number;
  todayDiscountTotal: number;
  todayExpenses: number;
  staffTimedInCount: number;
  lowStockIngredientCount: number;
}

function branchStats(overrides: Partial<BranchStatsOverview> = {}): BranchStatsOverview {
  return {
    branchId: 'branch-1',
    todayGrossSales: 0,
    todayTransactionCount: 0,
    todayDiscountTotal: 0,
    todayExpenses: 0,
    staffTimedInCount: 0,
    lowStockIngredientCount: 0,
    ...overrides,
  };
}

function transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
  return {
    id: 'txn-1',
    receipt_number: 'PC-MNL-20260716-0001',
    branch_id: 'branch-1',
    shift_id: 'shift-1',
    cashier_id: 'cashier-1',
    status: 'completed',
    payment_method: 'cash',
    subtotal: 100,
    discount_amount: 0,
    discount_type: null,
    vat_amount: 10.71,
    vat_exempt_amount: 0,
    total_amount: 100,
    cash_tendered: 100,
    change_given: 0,
    gcash_reference_number: null,
    payment_reference: null,
    gcash_manually_verified: null,
    has_payment_proof: false,
    payment_proof_type: null,
    payment_proof_uploaded_at: null,
    has_discount_proof: false,
    discount_proof_type: null,
    discount_proof_uploaded_at: null,
    receipt_printed: true,
    inventory_deduction_status: 'completed',
    is_offline_transaction: false,
    offline_provisional_number: null,
    synced_at: null,
    voided_at: null,
    voided_by_id: null,
    void_reason: null,
    refunded_at: null,
    refunded_by_id: null,
    refund_reason: null,
    created_at: '2026-07-16T02:00:00.000Z',
    updated_at: '2026-07-16T02:00:00.000Z',
    ...overrides,
  };
}

function inventoryAlert(overrides: Partial<InventoryStockAlert> = {}): InventoryStockAlert {
  return {
    inventory_item_id: 'item-1',
    name: 'Cheddar Powder',
    quantity_on_hand: 2,
    threshold: 5,
    severity: 'low',
    ...overrides,
  };
}

function attendanceRecord(overrides: Partial<AttendanceResponse> = {}): AttendanceResponse {
  return {
    id: 'record-1',
    employee_id: 'employee-1234-5678',
    branch_id: 'branch-1',
    clock_in_server_time: '2026-07-16T01:00:00.000Z',
    clock_in_gps_lat: 14.5995,
    clock_in_gps_lng: 120.9842,
    clock_in_gps_status: 'within_radius',
    clock_in_time_flag: false,
    clock_out_server_time: null,
    clock_out_gps_lat: null,
    clock_out_gps_lng: null,
    break_minutes: 0,
    actual_work_minutes: null,
    overtime_minutes: 0,
    status: 'present',
    correction_reason: null,
    corrected_by: null,
    original_record_id: null,
    created_at: '2026-07-16T01:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockBranchState({ activeBranchId: 'branch-1', activeBranch: { id: 'branch-1', name: 'Main Branch' } });
  mockSocketState({ isConnected: true, isReconnecting: false });
  mockUseShiftsRealtimeSync.mockReturnValue(undefined);
  mockUseTransactionsRealtimeSync.mockReturnValue(undefined);
  mockUseInventoryRealtimeSync.mockReturnValue(undefined);
  mockUseAttendanceRealtimeSync.mockReturnValue(undefined);
  mockUseAllBranchStats.mockReturnValue({ data: [branchStats()], isLoading: false });
  mockUseTransactions.mockReturnValue({ data: undefined, isLoading: false });
  mockUseBranchInventoryAlerts.mockReturnValue({ data: undefined, isLoading: false });
  mockUseAttendanceByBranch.mockReturnValue({ data: undefined, isLoading: false });
  mockUseBranches.mockReturnValue({ data: { branches: [{ id: 'branch-1' }], total: 1 }, isLoading: false, isError: false });
  mockUseDashboardSalesTrendReport.mockReturnValue({ data: { data: [] }, isLoading: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SupervisorDashboardPage', () => {
  it('renders a branch-not-configured empty state when no branch is selected but active branches exist', () => {
    mockBranchState({ activeBranchId: null, activeBranch: null });

    render(<SupervisorDashboardPage />);

    expect(screen.getByText('No branch configured')).toBeInTheDocument();
  });

  it('shows a loading spinner, not the no-branch message, while the active-branch list is still loading', () => {
    mockBranchState({ activeBranchId: null, activeBranch: null });
    mockUseBranches.mockReturnValue({ data: undefined, isLoading: true, isError: false });

    render(<SupervisorDashboardPage />);

    expect(screen.queryByText('No branch configured')).not.toBeInTheDocument();
    expect(screen.queryByText('No active branches available')).not.toBeInTheDocument();
  });

  it('shows an error state, not the no-branch message, when fetching active branches fails', () => {
    mockBranchState({ activeBranchId: null, activeBranch: null });
    mockUseBranches.mockReturnValue({ data: undefined, isLoading: false, isError: true });

    render(<SupervisorDashboardPage />);

    expect(screen.getByText("Couldn't load your branches")).toBeInTheDocument();
    expect(screen.queryByText('No branch configured')).not.toBeInTheDocument();
  });

  it('shows the zero-active-branches empty state only when the API genuinely returns none', () => {
    mockBranchState({ activeBranchId: null, activeBranch: null });
    mockUseBranches.mockReturnValue({ data: { branches: [], total: 0 }, isLoading: false, isError: false });

    render(<SupervisorDashboardPage />);

    expect(screen.getByText('No active branches available')).toBeInTheDocument();
    expect(screen.queryByText('No branch configured')).not.toBeInTheDocument();
  });

  it('renders loading skeletons for all panels when every query is loading', () => {
    mockUseAllBranchStats.mockReturnValue({ data: undefined, isLoading: true });
    mockUseTransactions.mockReturnValue({ data: undefined, isLoading: true });
    mockUseBranchInventoryAlerts.mockReturnValue({ data: undefined, isLoading: true });
    mockUseAttendanceByBranch.mockReturnValue({ data: undefined, isLoading: true });

    const { container } = render(<SupervisorDashboardPage />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders Gross Sales Today and Today\'s Transactions from branch day-stats regardless of any individual cashier shift state (Phase 4-9: shifts are auto-managed per cashier, not branch-wide)', () => {
    mockUseAllBranchStats.mockReturnValue({
      data: [branchStats({ todayGrossSales: 84.5, todayTransactionCount: 2 })],
      isLoading: false,
    });
    render(<SupervisorDashboardPage />);
    expect(screen.getByText('₱84.50')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders Gross Sales Today and Gross Sales This Month as distinct KPI cards with independent values', () => {
    mockUseAllBranchStats.mockReturnValue({ data: [branchStats({ todayGrossSales: 1500 })], isLoading: false });
    mockUseDashboardSalesTrendReport.mockReturnValue({
      data: { data: [{ gross_sales: 8000 }, { gross_sales: 3500 }] },
      isLoading: false,
    });
    render(<SupervisorDashboardPage />);
    expect(screen.getByText('Gross Sales Today')).toBeInTheDocument();
    expect(screen.getByText('₱1500')).toBeInTheDocument();
    expect(screen.getByText('Gross Sales This Month')).toBeInTheDocument();
    expect(screen.getByText('₱11500')).toBeInTheDocument();
  });

  it("renders Today's Expenses, Staff Clocked In, and Low Stock Items from branch day-stats", () => {
    mockUseAllBranchStats.mockReturnValue({
      data: [branchStats({ todayExpenses: 250.5, staffTimedInCount: 3, lowStockIngredientCount: 2 })],
      isLoading: false,
    });
    render(<SupervisorDashboardPage />);
    expect(screen.getByText("Today's Expenses")).toBeInTheDocument();
    expect(screen.getByText('₱250.50')).toBeInTheDocument();
    expect(screen.getByText('Staff Clocked In')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Low Stock Items')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('never renders Net Sales, (Estimated) Profit, or Discounts Given — not part of the TASK 165 KPI set', () => {
    mockUseAllBranchStats.mockReturnValue({ data: [branchStats({ todayDiscountTotal: 250.5 })], isLoading: false });
    render(<SupervisorDashboardPage />);
    expect(screen.queryByText('Net Sales')).not.toBeInTheDocument();
    expect(screen.queryByText(/Profit/)).not.toBeInTheDocument();
    expect(screen.queryByText('Discounts Given')).not.toBeInTheDocument();
  });

  it('renders inventory alerts sorted critical-first', () => {
    mockUseBranchInventoryAlerts.mockReturnValue({
      data: { branch_id: 'branch-1', alerts: [inventoryAlert({ inventory_item_id: 'low-1', name: 'Low Item', severity: 'low' }), inventoryAlert({ inventory_item_id: 'crit-1', name: 'Critical Item', severity: 'critical' })] },
      isLoading: false,
    });
    render(<SupervisorDashboardPage />);
    const names = screen.getAllByText(/\bItem\b/).map((el) => el.textContent);
    expect(names).toEqual(['Critical Item', 'Low Item']);
  });

  it('renders the healthy-stock empty state when there are no alerts', () => {
    mockUseBranchInventoryAlerts.mockReturnValue({ data: { branch_id: 'branch-1', alerts: [] }, isLoading: false });
    render(<SupervisorDashboardPage />);
    expect(screen.getByText('All stock levels are healthy')).toBeInTheDocument();
  });

  it('renders the clocked-in count from records with a null clock_out_server_time', () => {
    mockUseAttendanceByBranch.mockReturnValue({
      data: { records: [attendanceRecord({ id: 'r1', clock_out_server_time: null }), attendanceRecord({ id: 'r2', clock_out_server_time: '2026-07-16T09:00:00.000Z' })], total: 2, page: 1, limit: 100 },
      isLoading: false,
    });
    render(<SupervisorDashboardPage />);
    expect(screen.getByText('1 clocked in')).toBeInTheDocument();
    expect(screen.getByText('1 clocked out')).toBeInTheDocument();
  });

  it('renders the no-staff-clocked-in empty state when all records have clocked out', () => {
    mockUseAttendanceByBranch.mockReturnValue({
      data: { records: [attendanceRecord({ clock_out_server_time: '2026-07-16T09:00:00.000Z' })], total: 1, page: 1, limit: 100 },
      isLoading: false,
    });
    render(<SupervisorDashboardPage />);
    expect(screen.getByText('No staff currently clocked in')).toBeInTheDocument();
  });

  it('renders the recent transactions feed', () => {
    mockUseTransactions.mockReturnValue({ data: { transactions: [transaction()], total: 1, page: 1, limit: 10 }, isLoading: false });
    render(<SupervisorDashboardPage />);
    expect(screen.getByText('PC-MNL-20260716-0001')).toBeInTheDocument();
  });

  it('renders the no-transactions empty state when there are none', () => {
    mockUseTransactions.mockReturnValue({ data: { transactions: [], total: 0, page: 1, limit: 10 }, isLoading: false });
    render(<SupervisorDashboardPage />);
    expect(screen.getByText('No transactions this shift')).toBeInTheDocument();
  });

  it('calls all 4 realtime sync hooks on mount', () => {
    render(<SupervisorDashboardPage />);
    expect(mockUseShiftsRealtimeSync).toHaveBeenCalled();
    expect(mockUseTransactionsRealtimeSync).toHaveBeenCalled();
    expect(mockUseInventoryRealtimeSync).toHaveBeenCalled();
    expect(mockUseAttendanceRealtimeSync).toHaveBeenCalled();
  });

  it('renders a labeled Connected badge (not color-only) when connected', () => {
    mockSocketState({ isConnected: true, isReconnecting: false });
    render(<SupervisorDashboardPage />);
    expect(screen.getByText('Connected').closest('div')?.className).toContain('bg-success');
  });

  it('renders a labeled Disconnected badge when the socket drops', () => {
    mockSocketState({ isConnected: false, isReconnecting: false });
    render(<SupervisorDashboardPage />);
    expect(screen.getByText('Disconnected').closest('div')?.className).toContain('bg-destructive');
  });
});
