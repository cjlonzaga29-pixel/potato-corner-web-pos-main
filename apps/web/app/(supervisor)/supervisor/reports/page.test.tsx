import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type {
  AttendanceResponse,
  EmployeeResponse,
  InventoryItemResponse,
  InventoryStockMovementResponse,
  TransactionResponse,
  UnitOfMeasureResponse,
} from '@potato-corner/shared';
import SupervisorReportsPage from './page';

const {
  mockUseBranchStore,
  mockUseTransactions,
  mockUseTransaction,
  mockUseTransactionsRealtimeSync,
  mockUseInventoryStockMovements,
  mockUseInventoryStockRealtimeSync,
  mockUseUnitsOfMeasure,
  mockUseInventoryItems,
  mockUseAttendanceByBranch,
  mockUseAttendanceRealtimeSync,
  mockUseEmployees,
  mockUseAuthStore,
  mockUseRequestExport,
  mockUseReportsRealtimeSync,
} = vi.hoisted(() => ({
  mockUseBranchStore: vi.fn(),
  mockUseTransactions: vi.fn(),
  mockUseTransaction: vi.fn(),
  mockUseTransactionsRealtimeSync: vi.fn(),
  mockUseInventoryStockMovements: vi.fn(),
  mockUseInventoryStockRealtimeSync: vi.fn(),
  mockUseUnitsOfMeasure: vi.fn(),
  mockUseInventoryItems: vi.fn(),
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

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransactions: mockUseTransactions,
  useTransaction: mockUseTransaction,
  useTransactionsRealtimeSync: mockUseTransactionsRealtimeSync,
  useMarkReceiptPrinted: () => ({ mutateAsync: vi.fn() }),
  usePaymentProof: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', role: 'supervisor' } }),
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryStockMovements: mockUseInventoryStockMovements,
  useInventoryStockRealtimeSync: mockUseInventoryStockRealtimeSync,
  useUnitsOfMeasure: mockUseUnitsOfMeasure,
  useInventoryItems: mockUseInventoryItems,
}));

vi.mock('@/hooks/queries/use-attendance', () => ({
  useAttendanceByBranch: mockUseAttendanceByBranch,
  useAttendanceRealtimeSync: mockUseAttendanceRealtimeSync,
}));

vi.mock('@/hooks/queries/use-employees', () => ({
  useEmployees: mockUseEmployees,
  useEmployee: vi.fn(() => ({ data: undefined, isLoading: false })),
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
    payment_reference: null,
    gcash_manually_verified: null,
    has_payment_proof: false,
    payment_proof_type: null,
    payment_proof_uploaded_at: null,
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

function movement(overrides: Partial<InventoryStockMovementResponse> = {}): InventoryStockMovementResponse {
  return {
    id: 'movement-1',
    branch_id: 'branch-1',
    inventory_item_id: 'item-1',
    inventory_item_name: 'Cheddar Powder',
    movement_type: 'RECEIVING',
    quantity_change: 10,
    quantity_before: 5,
    quantity_after: 15,
    unit_id: null,
    reference_type: null,
    reference_id: null,
    notes: null,
    performed_by_user_id: null,
    created_at: '2026-07-16T02:00:00.000Z',
    ...overrides,
  };
}

function unitOfMeasure(overrides: Partial<UnitOfMeasureResponse> = {}): UnitOfMeasureResponse {
  return {
    id: 'unit-1',
    code: 'pc',
    name: 'Piece',
    dimension: 'COUNT',
    is_base_unit: true,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function inventoryItem(overrides: Partial<InventoryItemResponse> = {}): InventoryItemResponse {
  return {
    id: 'item-1',
    name: 'Cheddar Powder',
    sku: null,
    barcode: null,
    category_id: null,
    category_name: null,
    base_unit_id: 'unit-1',
    base_unit_code: 'pc',
    track_inventory: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
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
    position: 'Cashier',
    notes: null,
    is_active: true,
    status: 'active',
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

beforeEach(() => {
  mockBranchState({ activeBranchId: 'branch-1', activeBranch: { id: 'branch-1', name: 'Main Branch' } });
  mockUseTransactionsRealtimeSync.mockReturnValue(undefined);
  mockUseInventoryStockRealtimeSync.mockReturnValue(undefined);
  mockUseAttendanceRealtimeSync.mockReturnValue(undefined);
  mockTransactionsByStatus({});
  mockUseInventoryStockMovements.mockReturnValue({ data: { movements: [], total: 0, page: 1, limit: 100 }, isLoading: false, isError: false, refetch: vi.fn() });
  mockUseUnitsOfMeasure.mockReturnValue({ data: [unitOfMeasure()], isLoading: false });
  mockUseInventoryItems.mockReturnValue({ data: [inventoryItem()], isLoading: false });
  mockUseAttendanceByBranch.mockReturnValue({ data: { records: [], total: 0, page: 1, limit: 100 }, isLoading: false, isError: false, refetch: vi.fn() });
  mockUseEmployees.mockReturnValue({ data: { employees: [], total: 0, page: 1, limit: 100 }, isLoading: false });
  mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
    selector({ user: { id: 'user-1', role: 'supervisor' } }),
  );
  mockUseTransaction.mockReturnValue({ data: undefined, isLoading: false });
  mockUseRequestExport.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseReportsRealtimeSync.mockReturnValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SupervisorReportsPage', () => {
  it('renders all report tabs, with no Shift Summary or Cash Reconciliation', () => {
    render(<SupervisorReportsPage />);
    for (const label of [
      'Daily Sales',
      'Sold Product Transactions',
      'Void/Refund',
      'Discount Compliance',
      'Inventory Movement',
      'Attendance Summary',
    ]) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('tab', { name: 'Shift Summary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Cash Reconciliation' })).not.toBeInTheDocument();
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
    expect(screen.getByText('Gross Sales — Selected Period')).toBeInTheDocument();
    expect(screen.getByText('₱300')).toBeInTheDocument();
    expect(screen.getByText('VAT Collected')).toBeInTheDocument();
    expect(screen.getByText('₱30')).toBeInTheDocument();
    expect(screen.getByText('Discounts Given')).toBeInTheDocument();
    expect(screen.getByText('₱5')).toBeInTheDocument();
  });

  // Phase 10-11: Supervisor oversight of receipts/payment proofs, via the
  // shared ReportsView component's Daily Sales tab (gated on role — staff
  // already have their own Receipts page and don't get these actions).
  describe('Daily Sales — receipt and payment-proof viewing (Phase 10-11)', () => {
    it('shows a View Receipt action and a Payment Proof column for the supervisor role', () => {
      mockTransactionsByStatus({
        completed: {
          data: [transaction({ id: 't1', payment_method: 'gcash', has_payment_proof: true })],
        },
      });

      render(<SupervisorReportsPage />);

      expect(screen.getByRole('button', { name: 'View Receipt' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'View Proof' })).toBeInTheDocument();
    });

    it('opens the receipt modal with the fetched transaction when View Receipt is clicked', () => {
      mockTransactionsByStatus({ completed: { data: [transaction({ id: 't1' })] } });
      mockUseTransaction.mockImplementation((transactionId: string | null) =>
        transactionId ? { data: transaction({ id: 't1' }), isLoading: false } : { data: undefined, isLoading: false },
      );

      render(<SupervisorReportsPage />);
      expect(screen.queryByText('Receipt')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'View Receipt' }));

      expect(screen.getByText('Receipt')).toBeInTheDocument();
    });

    it('shows "No proof uploaded" instead of a View Proof button when has_payment_proof is false', () => {
      mockTransactionsByStatus({
        completed: { data: [transaction({ id: 't1', payment_method: 'gcash', has_payment_proof: false })] },
      });

      render(<SupervisorReportsPage />);

      expect(screen.getByText('No proof uploaded')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'View Proof' })).not.toBeInTheDocument();
    });

    it('shows a dash instead of any proof action for cash transactions', () => {
      mockTransactionsByStatus({
        completed: { data: [transaction({ id: 't1', payment_method: 'cash', has_payment_proof: false })] },
      });

      render(<SupervisorReportsPage />);

      expect(screen.queryByText('No proof uploaded')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'View Proof' })).not.toBeInTheDocument();
    });

    it('does not show View Receipt/Payment Proof actions for a non-supervisor role', () => {
      mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
        selector({ user: { id: 'user-1', role: 'branch' } }),
      );
      mockTransactionsByStatus({
        completed: { data: [transaction({ id: 't1', payment_method: 'gcash', has_payment_proof: true })] },
      });

      render(<SupervisorReportsPage />);

      expect(screen.queryByRole('button', { name: 'View Receipt' })).not.toBeInTheDocument();
      expect(screen.queryByText('Payment Proof')).not.toBeInTheDocument();
    });
  });

  it('renders a transaction row on the Sold Product Transactions tab', () => {
    mockUseTransactions.mockReturnValue({
      data: { transactions: [transaction({ id: 't1', receipt_number: 'PC-SOLD-0001' })], total: 1, page: 1, limit: 100 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<SupervisorReportsPage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Sold Product Transactions' }));

    expect(screen.getByText('PC-SOLD-0001')).toBeInTheDocument();
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
    mockUseInventoryStockMovements.mockReturnValue({
      data: {
        movements: [
          movement({ id: 'm1', movement_type: 'RECEIVING' }),
          movement({ id: 'm2', movement_type: 'WASTE' }),
          movement({ id: 'm3', movement_type: 'ADJUSTMENT_IN' }),
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
    // "RECEIVING"/"WASTE" also appear as movement-type badges in the table
    // rows below the KPI row, so more than one match is expected here.
    expect(screen.getAllByText('RECEIVING').length).toBeGreaterThan(0);
    expect(screen.getAllByText('WASTE').length).toBeGreaterThan(0);
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
    mockTransactionsByStatus({ completed: { data: [], isLoading: true }, voided: { data: [], isLoading: false }, refunded: { data: [], isLoading: false } });

    render(<SupervisorReportsPage />);
    expect(screen.getAllByText('loading').length).toBeGreaterThan(0);

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Void/Refund' }));
    expect(screen.queryAllByText('loading')).toHaveLength(0);
  });

  it('renders an EmptyState on every tab when its data is empty', () => {
    render(<SupervisorReportsPage />);
    expect(screen.getByText('No sales')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Sold Product Transactions' }));
    expect(screen.getByText('No sold products')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Void/Refund' }));
    expect(screen.getByText('No voids or refunds')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Discount Compliance' }));
    expect(screen.getByText('No discounted transactions')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Inventory Movement' }));
    expect(screen.getByText('No inventory movements')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Attendance Summary' }));
    expect(screen.getByText('No attendance records')).toBeInTheDocument();
  });

  it('calls all 3 realtime sync hooks on mount', () => {
    render(<SupervisorReportsPage />);
    expect(mockUseTransactionsRealtimeSync).toHaveBeenCalled();
    expect(mockUseInventoryStockRealtimeSync).toHaveBeenCalled();
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

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'csv', report_type: 'DAILY_SALES' }), expect.anything());
  });

  it('calls useRequestExport().mutate with format pdf on Export PDF click', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    render(<SupervisorReportsPage />);

    fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'pdf' }), expect.anything());
  });

  it('renders both export buttons with type="button" and outside any form', () => {
    render(<SupervisorReportsPage />);
    const csvButton = screen.getByRole('button', { name: /export csv/i });
    const pdfButton = screen.getByRole('button', { name: /export pdf/i });
    expect(csvButton).toHaveAttribute('type', 'button');
    expect(pdfButton).toHaveAttribute('type', 'button');
    expect(csvButton.closest('form')).toBeNull();
    expect(pdfButton.closest('form')).toBeNull();
  });

  it('does not disable/change the Refresh button when Export CSV is clicked', () => {
    render(<SupervisorReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect(screen.getByRole('button', { name: /^refresh$/i })).not.toBeDisabled();
  });

  it('shows the CSV loading label while exporting and does not affect the PDF button', () => {
    const mutate = vi.fn(); // never resolves/settles in this test — loading state stays on
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    render(<SupervisorReportsPage />);

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(screen.getByRole('button', { name: /exporting csv/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeEnabled();
  });

  it('disables the CSV button after one click so a rapid second click sends only one request', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    render(<SupervisorReportsPage />);

    const csvButton = screen.getByRole('button', { name: /export csv/i });
    fireEvent.click(csvButton);
    // The button is now disabled (isExportingCsv=true) — a second rapid click
    // on a disabled element does not fire onClick.
    fireEvent.click(screen.getByRole('button', { name: /exporting csv/i }));

    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('resets the CSV button to idle and enabled once the mutation settles (success or failure)', async () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    render(<SupervisorReportsPage />);

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    const onSettled = mutate.mock.calls.at(-1)?.[1]?.onSettled;
    expect(typeof onSettled).toBe('function');

    await act(async () => {
      onSettled();
    });

    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
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
