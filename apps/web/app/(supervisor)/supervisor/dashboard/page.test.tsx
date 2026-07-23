import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AttendanceResponse, InventoryAlert, ShiftResponse, TransactionResponse } from '@potato-corner/shared';
import SupervisorDashboardPage from './page';

const {
  mockPush,
  mockUseCurrentShift,
  mockUseShiftsRealtimeSync,
  mockUseTransactions,
  mockUseTransactionsRealtimeSync,
  mockUseBranchInventoryAlerts,
  mockUseInventoryRealtimeSync,
  mockUseAttendanceByBranch,
  mockUseAttendanceRealtimeSync,
  mockUseBranchStore,
  mockUseSocketStore,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseCurrentShift: vi.fn(),
  mockUseShiftsRealtimeSync: vi.fn(),
  mockUseTransactions: vi.fn(),
  mockUseTransactionsRealtimeSync: vi.fn(),
  mockUseBranchInventoryAlerts: vi.fn(),
  mockUseInventoryRealtimeSync: vi.fn(),
  mockUseAttendanceByBranch: vi.fn(),
  mockUseAttendanceRealtimeSync: vi.fn(),
  mockUseBranchStore: vi.fn(),
  mockUseSocketStore: vi.fn(),
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

vi.mock('@/hooks/queries/use-shifts', () => ({
  useCurrentShift: mockUseCurrentShift,
  useShiftsRealtimeSync: mockUseShiftsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransactions: mockUseTransactions,
  useTransactionsRealtimeSync: mockUseTransactionsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-inventory', () => ({
  useBranchInventoryAlerts: mockUseBranchInventoryAlerts,
  useInventoryRealtimeSync: mockUseInventoryRealtimeSync,
}));

vi.mock('@/hooks/queries/use-attendance', () => ({
  useAttendanceByBranch: mockUseAttendanceByBranch,
  useAttendanceRealtimeSync: mockUseAttendanceRealtimeSync,
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
    gcash_manually_verified: null,
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

function inventoryAlert(overrides: Partial<InventoryAlert> = {}): InventoryAlert {
  return {
    ingredient_id: 'ing-1',
    name: 'Cheddar Powder',
    unit: 'kg',
    current_stock: 2,
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
  mockUseCurrentShift.mockReturnValue({ data: null, isLoading: false });
  mockUseTransactions.mockReturnValue({ data: undefined, isLoading: false });
  mockUseBranchInventoryAlerts.mockReturnValue({ data: undefined, isLoading: false });
  mockUseAttendanceByBranch.mockReturnValue({ data: undefined, isLoading: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SupervisorDashboardPage', () => {
  it('renders a branch-not-configured empty state when no branch is selected', () => {
    mockBranchState({ activeBranchId: null, activeBranch: null });

    render(<SupervisorDashboardPage />);

    expect(screen.getByText('No branch configured')).toBeInTheDocument();
    expect(screen.queryByText('No active shift')).not.toBeInTheDocument();
  });

  it('renders loading skeletons for all panels when every query is loading', () => {
    mockUseCurrentShift.mockReturnValue({ data: undefined, isLoading: true });
    mockUseTransactions.mockReturnValue({ data: undefined, isLoading: true });
    mockUseBranchInventoryAlerts.mockReturnValue({ data: undefined, isLoading: true });
    mockUseAttendanceByBranch.mockReturnValue({ data: undefined, isLoading: true });

    const { container } = render(<SupervisorDashboardPage />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders the no-active-shift empty state when useCurrentShift returns null', () => {
    render(<SupervisorDashboardPage />);
    expect(screen.getByText('No active shift')).toBeInTheDocument();
  });

  it('renders shift details when useCurrentShift returns a shift', () => {
    mockUseCurrentShift.mockReturnValue({ data: shift(), isLoading: false });
    render(<SupervisorDashboardPage />);
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
  });

  it('renders gross sales from gross_sales_total formatted as PHP currency', () => {
    mockUseCurrentShift.mockReturnValue({ data: shift({ gross_sales_total: 4500.5 }), isLoading: false });
    render(<SupervisorDashboardPage />);
    expect(screen.getByText('₱4500.50')).toBeInTheDocument();
  });

  it('renders transaction_count, not total_transaction_count', () => {
    mockUseCurrentShift.mockReturnValue({ data: shift({ transaction_count: 42, total_transaction_count: 99 }), isLoading: false });
    render(<SupervisorDashboardPage />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.queryByText('99')).not.toBeInTheDocument();
  });

  it('renders inventory alerts sorted critical-first', () => {
    mockUseBranchInventoryAlerts.mockReturnValue({
      data: { branch_id: 'branch-1', alerts: [inventoryAlert({ ingredient_id: 'low-1', name: 'Low Item', severity: 'low' }), inventoryAlert({ ingredient_id: 'crit-1', name: 'Critical Item', severity: 'critical' })] },
      isLoading: false,
    });
    render(<SupervisorDashboardPage />);
    const names = screen.getAllByText(/Item/).map((el) => el.textContent);
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

  it('renders a green connection indicator when connected', () => {
    mockSocketState({ isConnected: true, isReconnecting: false });
    render(<SupervisorDashboardPage />);
    expect(screen.getByTitle('Connected').className).toContain('bg-green-500');
  });

  it('renders a red connection indicator when disconnected', () => {
    mockSocketState({ isConnected: false, isReconnecting: false });
    render(<SupervisorDashboardPage />);
    expect(screen.getByTitle('Disconnected').className).toContain('bg-red-500');
  });
});
