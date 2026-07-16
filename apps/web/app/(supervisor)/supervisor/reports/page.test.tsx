import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { AttendanceResponse, EmployeeResponse, MovementResponse, ShiftResponse, TransactionResponse } from '@potato-corner/shared';
import { formatCurrency } from '@/lib/utils';
import SupervisorReportsPage from './page';

const {
  mockUseBranchStore,
  mockUseShifts,
  mockUseShiftsRealtimeSync,
  mockUseTransactions,
  mockUseTransactionsRealtimeSync,
  mockUseInventoryMovements,
  mockUseInventoryRealtimeSync,
  mockUseAttendanceByBranch,
  mockUseAttendanceRealtimeSync,
  mockUseEmployees,
  mockUseAuthStore,
  mockUseRequestExport,
  mockUseReportsRealtimeSync,
} = vi.hoisted(() => ({
  mockUseBranchStore: vi.fn(),
  mockUseShifts: vi.fn(),
  mockUseShiftsRealtimeSync: vi.fn(),
  mockUseTransactions: vi.fn(),
  mockUseTransactionsRealtimeSync: vi.fn(),
  mockUseInventoryMovements: vi.fn(),
  mockUseInventoryRealtimeSync: vi.fn(),
  mockUseAttendanceByBranch: vi.fn(),
  mockUseAttendanceRealtimeSync: vi.fn(),
  mockUseEmployees: vi.fn(),
  mockUseAuthStore: vi.fn(),
  mockUseRequestExport: vi.fn(),
  mockUseReportsRealtimeSync: vi.fn(),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/hooks/queries/use-shifts', () => ({
  useShifts: mockUseShifts,
  useShiftsRealtimeSync: mockUseShiftsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransactions: mockUseTransactions,
  useTransactionsRealtimeSync: mockUseTransactionsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-inventory', () => ({
  useInventoryMovements: mockUseInventoryMovements,
  useInventoryRealtimeSync: mockUseInventoryRealtimeSync,
}));

vi.mock('@/hooks/queries/use-attendance', () => ({
  useAttendanceByBranch: mockUseAttendanceByBranch,
  useAttendanceRealtimeSync: mockUseAttendanceRealtimeSync,
}));

vi.mock('@/hooks/queries/use-employees', () => ({
  useEmployees: mockUseEmployees,
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: mockUseAuthStore,
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useRequestExport: mockUseRequestExport,
  useReportsRealtimeSync: mockUseReportsRealtimeSync,
}));

/**
 * KpiCard's NumberTicker animates via Framer Motion springs driven by
 * requestAnimationFrame, which never ticks synchronously in jsdom. Swapping
 * in a plain, synchronous render (title/value/prefix as text, matching the
 * admin/supervisor dashboard tests' approach) lets tests verify the
 * *computed* KPI values the page passes down.
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

function mockBranchState(state: BranchState) {
  mockUseBranchStore.mockImplementation((selector: (s: BranchState) => unknown) => selector(state));
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
    started_at: new Date().toISOString(),
    closed_at: null,
    ...overrides,
  };
}

function movement(overrides: Partial<MovementResponse> = {}): MovementResponse {
  return {
    id: 'movement-1',
    branch_id: 'branch-1',
    ingredient_id: 'ingredient-1',
    ingredient_name: 'Cheddar Powder',
    movement_type: 'stock_in',
    quantity_change: 10,
    quantity_before: 5,
    quantity_after: 15,
    reference_id: null,
    notes: null,
    image_proof_url: null,
    image_proof_type: null,
    approved_by: null,
    recorded_by: null,
    created_at: '2026-07-16T02:00:00.000Z',
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

function employee(overrides: Partial<EmployeeResponse> = {}): EmployeeResponse {
  return {
    id: 'employee-1234-5678',
    email: 'juan@example.com',
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    phone: null,
    role: 'staff',
    employment_type: 'regular',
    employee_id: 'PC-EMP-000001',
    is_active: true,
    must_change_password: false,
    branch_assignments: [],
    last_login_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface TransactionFiltersArg {
  status?: 'completed' | 'voided' | 'refunded';
}

interface QueryState<T> {
  data: T;
  isLoading?: boolean;
  isError?: boolean;
}

function mockTransactionsByStatus(map: Partial<Record<'completed' | 'voided' | 'refunded', QueryState<TransactionResponse[]>>>) {
  mockUseTransactions.mockImplementation((filters: TransactionFiltersArg) => {
    const entry = filters.status ? map[filters.status] : undefined;
    const transactions = entry?.data ?? [];
    return {
      data: { transactions, total: transactions.length, page: 1, limit: 100 },
      isLoading: entry?.isLoading ?? false,
      isError: entry?.isError ?? false,
      refetch: vi.fn(),
    };
  });
}

interface ShiftFiltersArg {
  status?: 'active' | 'closed' | 'flagged';
}

function mockShiftsByStatus(map: { all?: QueryState<ShiftResponse[]>; closed?: QueryState<ShiftResponse[]> }) {
  mockUseShifts.mockImplementation((filters: ShiftFiltersArg) => {
    const entry = filters.status === 'closed' ? map.closed : map.all;
    const shifts = entry?.data ?? [];
    return {
      data: { shifts, total: shifts.length, page: 1, limit: 100 },
      isLoading: entry?.isLoading ?? false,
      isError: entry?.isError ?? false,
      refetch: vi.fn(),
    };
  });
}

beforeEach(() => {
  mockBranchState({ activeBranchId: 'branch-1', activeBranch: { id: 'branch-1', name: 'Main Branch' } });
  mockUseShiftsRealtimeSync.mockReturnValue(undefined);
  mockUseTransactionsRealtimeSync.mockReturnValue(undefined);
  mockUseInventoryRealtimeSync.mockReturnValue(undefined);
  mockUseAttendanceRealtimeSync.mockReturnValue(undefined);
  mockTransactionsByStatus({});
  mockShiftsByStatus({});
  mockUseInventoryMovements.mockReturnValue({ data: { movements: [], total: 0, page: 1, limit: 100 }, isLoading: false, isError: false, refetch: vi.fn() });
  mockUseAttendanceByBranch.mockReturnValue({ data: { records: [], total: 0, page: 1, limit: 100 }, isLoading: false, isError: false, refetch: vi.fn() });
  mockUseEmployees.mockReturnValue({ data: { employees: [], total: 0, page: 1, limit: 100 }, isLoading: false });
  mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string } }) => unknown) => selector({ user: { id: 'user-1' } }));
  mockUseRequestExport.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseReportsRealtimeSync.mockReturnValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SupervisorReportsPage', () => {
  it('renders all 7 report tabs', () => {
    render(<SupervisorReportsPage />);
    for (const label of [
      'Daily Sales',
      'Shift Summary',
      'Cash Reconciliation',
      'Void/Refund',
      'Discount Compliance',
      'Inventory Movement',
      'Attendance Summary',
    ]) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('renders Daily Sales KPI sums computed from completed transactions', () => {
    mockTransactionsByStatus({
      completed: {
        data: [
          transaction({ id: 't1', total_amount: 100, vat_amount: 10, discount_amount: 5 }),
          transaction({ id: 't2', total_amount: 200, vat_amount: 20, discount_amount: 0 }),
        ],
      },
    });

    render(<SupervisorReportsPage />);

    expect(screen.getByText('Total Transactions')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Gross Sales')).toBeInTheDocument();
    expect(screen.getByText('₱300')).toBeInTheDocument();
    expect(screen.getByText('VAT Collected')).toBeInTheDocument();
    expect(screen.getByText('₱30')).toBeInTheDocument();
    expect(screen.getByText('Discounts Given')).toBeInTheDocument();
    expect(screen.getByText('₱5')).toBeInTheDocument();
  });

  it('renders the shift list on the Shift Summary tab', () => {
    mockShiftsByStatus({
      all: { data: [shift({ id: 's1', cash_sales_total: 1000, gcash_sales_total: 500 })] },
    });

    render(<SupervisorReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Shift Summary' }));

    expect(screen.getByText(formatCurrency(1000))).toBeInTheDocument();
    expect(screen.getByText(formatCurrency(500))).toBeInTheDocument();
  });

  it('shows both voided and refunded transactions on the Void/Refund tab', () => {
    mockTransactionsByStatus({
      voided: { data: [transaction({ id: 'v1', receipt_number: 'PC-VOID-0001', status: 'voided' })] },
      refunded: { data: [transaction({ id: 'r1', receipt_number: 'PC-REFUND-0001', status: 'refunded' })] },
    });

    render(<SupervisorReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Void/Refund' }));

    expect(screen.getByText('PC-VOID-0001')).toBeInTheDocument();
    expect(screen.getByText('PC-REFUND-0001')).toBeInTheDocument();
  });

  it('shows the correct clocked-in count on the Attendance Summary tab', () => {
    mockUseAttendanceByBranch.mockReturnValue({
      data: {
        records: [
          attendanceRecord({ id: 'a1', clock_out_server_time: null }),
          attendanceRecord({ id: 'a2', clock_out_server_time: new Date().toISOString() }),
        ],
        total: 2,
        page: 1,
        limit: 100,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<SupervisorReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Attendance Summary' }));

    expect(screen.getByText('Clocked In Now')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders movement-type KPI counts and rows on the Inventory Movement tab', () => {
    mockUseInventoryMovements.mockReturnValue({
      data: {
        movements: [
          movement({ id: 'm1', movement_type: 'stock_in' }),
          movement({ id: 'm2', movement_type: 'waste' }),
          movement({ id: 'm3', movement_type: 'manual_adjustment' }),
        ],
        total: 3,
        page: 1,
        limit: 100,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<SupervisorReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Inventory Movement' }));

    expect(screen.getByText('Total Movements')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // "Stock In"/"Waste" also appear as movement-type badges in the table
    // rows below the KPI row, so more than one match is expected here.
    expect(screen.getAllByText('Stock In').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Waste').length).toBeGreaterThan(0);
    expect(screen.getByText('Adjustments')).toBeInTheDocument();
  });

  it('resolves employee names on the Attendance Summary table from the employees list', () => {
    mockUseEmployees.mockReturnValue({
      data: { employees: [employee({ id: 'employee-1234-5678', first_name: 'Maria', last_name: 'Santos' })], total: 1, page: 1, limit: 100 },
      isLoading: false,
    });
    mockUseAttendanceByBranch.mockReturnValue({
      data: { records: [attendanceRecord({ id: 'a1', employee_id: 'employee-1234-5678' })], total: 1, page: 1, limit: 100 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<SupervisorReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Attendance Summary' }));

    expect(screen.getByText('Maria Santos')).toBeInTheDocument();
  });

  it('re-fetches with updated date params after changing the filter and clicking Refresh', () => {
    render(<SupervisorReportsPage />);

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-01-31' } });
    fireEvent.click(screen.getByRole('button', { name: /^refresh/i }));

    expect(mockUseTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ date_from: '2026-01-01', date_to: '2026-01-31' }),
    );
  });

  it('renders each tab-scoped loading state independently', () => {
    mockTransactionsByStatus({ completed: { data: [], isLoading: true } });
    mockShiftsByStatus({ all: { data: [], isLoading: false } });

    render(<SupervisorReportsPage />);
    expect(screen.getAllByText('loading').length).toBeGreaterThan(0);

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Shift Summary' }));
    expect(screen.queryAllByText('loading')).toHaveLength(0);
  });

  it('renders an EmptyState on every tab when its data is empty', () => {
    render(<SupervisorReportsPage />);
    expect(screen.getByText('No sales')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Shift Summary' }));
    expect(screen.getByText('No shifts')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Cash Reconciliation' }));
    expect(screen.getByText('No closed shifts')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Void/Refund' }));
    expect(screen.getByText('No voids or refunds')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Discount Compliance' }));
    expect(screen.getByText('No discounted transactions')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Inventory Movement' }));
    expect(screen.getByText('No inventory movements')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Attendance Summary' }));
    expect(screen.getByText('No attendance records')).toBeInTheDocument();
  });

  it('calls all 4 realtime sync hooks on mount', () => {
    render(<SupervisorReportsPage />);
    expect(mockUseShiftsRealtimeSync).toHaveBeenCalled();
    expect(mockUseTransactionsRealtimeSync).toHaveBeenCalled();
    expect(mockUseInventoryRealtimeSync).toHaveBeenCalled();
    expect(mockUseAttendanceRealtimeSync).toHaveBeenCalled();
  });

  it('renders a branch-selection message when no branch is active', () => {
    mockBranchState({ activeBranchId: null, activeBranch: null });
    render(<SupervisorReportsPage />);
    expect(screen.getByText('Select an active branch to view its reports.')).toBeInTheDocument();
  });
});

describe('export controls', () => {
  it('renders Export CSV and Export PDF buttons', () => {
    render(<SupervisorReportsPage />);
    expect(screen.getByRole('button', { name: /export csv/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export pdf/i })).toBeInTheDocument();
  });

  it('calls useRequestExport().mutate with format csv and the active tab report_type on Export CSV click', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    render(<SupervisorReportsPage />);

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'csv', report_type: 'DAILY_SALES' }));
  });

  it('calls useRequestExport().mutate with format pdf on Export PDF click', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    render(<SupervisorReportsPage />);

    fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'pdf' }));
  });
});

describe('refresh cooldown', () => {
  it('disables the Refresh button for 60 seconds after click', () => {
    vi.useFakeTimers();
    render(<SupervisorReportsPage />);

    fireEvent.click(screen.getByRole('button', { name: /^refresh/i }));

    expect(screen.getByRole('button', { name: /refresh \(60s\)/i })).toBeDisabled();
    vi.useRealTimers();
  });
});

describe('realtime sync', () => {
  it('calls useReportsRealtimeSync on mount', () => {
    render(<SupervisorReportsPage />);
    expect(mockUseReportsRealtimeSync).toHaveBeenCalled();
  });
});

describe('branch selector', () => {
  it('does not render a branch selector (branch is implicit from useBranchStore)', () => {
    render(<SupervisorReportsPage />);
    expect(screen.queryByLabelText(/branch/i)).not.toBeInTheDocument();
  });
});
