import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import type { InventoryConsumptionSummaryReportRow, InventoryStockMovementResponse, ReportPeriodSummary, UnitOfMeasureResponse, InventoryItemResponse, TransactionResponse } from '@potato-corner/shared';
import { ReportsView } from './reports-view';
// POS-PERF-P62 — page-level tests, 1.1-1.4s each alone on the P62 laptop and about 4x slower
// in the full parallel suite, past the 5s default there (P62 runbook §7). This file only.
vi.setConfig({ testTimeout: 15_000 });

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
  mockUseDiscountComplianceReport,
  mockUseDiscountAuditTrail,
  mockUseReportPeriodSummary,
  mockUseInventoryConsumptionSummaryReport,
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
  mockUseDiscountComplianceReport: vi.fn(),
  mockUseDiscountAuditTrail: vi.fn(),
  mockUseReportPeriodSummary: vi.fn(),
  mockUseInventoryConsumptionSummaryReport: vi.fn(),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransactions: mockUseTransactions,
  useTransaction: mockUseTransaction,
  useTransactionsRealtimeSync: mockUseTransactionsRealtimeSync,
  useDiscountAuditTrail: mockUseDiscountAuditTrail,
  useMarkReceiptPrinted: () => ({ mutateAsync: vi.fn() }),
  usePaymentProof: () => ({ data: undefined, isLoading: false, isError: false }),
  useDiscountProof: () => ({ data: undefined, isLoading: false, isError: false }),
  // ViewTransactionDetailDialog (mounted whenever isSupervisor is true,
  // unrelated to this task) calls these unconditionally — only exercised
  // now because these are the first tests in this file to set the mocked
  // role to 'supervisor'.
  useVoidTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRefundTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRetryInventoryDeduction: () => ({ mutate: vi.fn(), isPending: false }),
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
  // ReceiptModal (mounted whenever isSupervisor is true, unrelated to this
  // task) calls this unconditionally — only exercised now because these are
  // the first tests in this file to set the mocked role to 'supervisor'.
  useEmployee: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: mockUseAuthStore,
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useRequestExport: mockUseRequestExport,
  useReportsRealtimeSync: mockUseReportsRealtimeSync,
  useDiscountComplianceReport: mockUseDiscountComplianceReport,
  useReportPeriodSummary: mockUseReportPeriodSummary,
  useReportPeriodSummaryRealtimeSync: vi.fn(),
  useInventoryConsumptionSummaryReport: mockUseInventoryConsumptionSummaryReport,
}));

/** Swaps Framer Motion's async NumberTicker for a synchronous text node — same approach as the supervisor/admin reports page tests. */
vi.mock('@/components/shared/charts/kpi-card', () => ({
  KpiCard: ({ title, value, isLoading, valueText, caption }: { title: string; value: number; isLoading?: boolean; valueText?: string; caption?: string }) => (
    <div className="app-kpi-card">
      <span>{title}</span>
      <span>{isLoading ? 'loading' : (valueText ?? String(value))}</span>
      {caption && <span>{caption}</span>}
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

function stockMovement(overrides: Partial<InventoryStockMovementResponse> = {}): InventoryStockMovementResponse {
  return {
    id: 'movement-1',
    branch_id: 'branch-1',
    inventory_item_id: 'item-1',
    inventory_item_name: 'Large Cup',
    movement_type: 'RECEIVING',
    quantity_change: 500,
    quantity_before: 0,
    quantity_after: 500,
    unit_id: 'unit-1',
    unit_code: 'pcs',
    reference_type: null,
    reference_id: null,
    notes: null,
    performed_by_user_id: null,
    unit_cost: null,
    total_cost: null,
    responsible_user_id: null,
    entered_quantity: null,
    entered_unit_id: null,
    entered_unit_code: null,
    proof_url: null,
    performed_by_name: null,
    responsible_user_name: null,
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
    name: 'Large Cup',
    sku: 'SKU-001',
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

function periodSummary(overrides: Partial<ReportPeriodSummary> = {}): ReportPeriodSummary {
  return {
    sales: { completed_count: 0, completed_total_amount: 0, completed_discount_amount: 0, voided_count: 0, voided_total_amount: 0, refunded_count: 0, refunded_total_amount: 0 },
    movements: { total_count: 0, receiving_count: 0, waste_count: 0, adjustment_count: 0, sale_count: 0 },
    attendance: { record_count: 0, open_count: 0, work_minutes: 0, overtime_minutes: 0 },
    sold_product_names: [],
    ...overrides,
  };
}

function consumptionRow(overrides: Partial<InventoryConsumptionSummaryReportRow>): InventoryConsumptionSummaryReportRow {
  return { ingredient_id: 'item-1', ingredient_name: 'Cheese Flavor', branch_id: 'branch-1', branch_name: 'Main Branch', unit: 'g', quantity_consumed: 0, unit_cost: null, consumption_value: null, has_unknown_cost: false, movement_count: 1, ...overrides };
}

function mockConsumption(rows: InventoryConsumptionSummaryReportRow[]) {
  mockUseInventoryConsumptionSummaryReport.mockReturnValue({ data: { data: rows, total: rows.length }, isLoading: false, isError: false, refetch: vi.fn() });
}

function mockMovements(movements: InventoryStockMovementResponse[], overrides: Partial<{ isLoading: boolean; isError: boolean }> = {}) {
  mockUseInventoryStockMovements.mockReturnValue({
    data: { movements, total: movements.length, page: 1, limit: 100 },
    isLoading: overrides.isLoading ?? false,
    isError: overrides.isError ?? false,
    refetch: vi.fn(),
  });
}

beforeEach(() => {
  mockBranchState({ activeBranchId: 'branch-1', activeBranch: { id: 'branch-1', name: 'Main Branch' } });
  mockUseTransactionsRealtimeSync.mockReturnValue(undefined);
  mockUseInventoryStockRealtimeSync.mockReturnValue(undefined);
  mockUseAttendanceRealtimeSync.mockReturnValue(undefined);
  mockUseTransactions.mockReturnValue({
    data: { transactions: [], total: 0, page: 1, limit: 100 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUseTransaction.mockReturnValue({ data: undefined, isLoading: false });
  mockMovements([]);
  mockUseUnitsOfMeasure.mockReturnValue({ data: [unitOfMeasure()], isLoading: false });
  mockUseInventoryItems.mockReturnValue({ data: [inventoryItem()], isLoading: false });
  mockUseAttendanceByBranch.mockReturnValue({ data: { records: [], total: 0, page: 1, limit: 100 }, isLoading: false, isError: false, refetch: vi.fn() });
  mockUseEmployees.mockReturnValue({ data: { employees: [], total: 0, page: 1, limit: 100 }, isLoading: false });
  mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string } }) => unknown) => selector({ user: { id: 'user-1' } }));
  mockUseRequestExport.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseReportsRealtimeSync.mockReturnValue(undefined);
  // Task 209.56E — the Discount Report's headline KPIs now read from this
  // hook (server groupBy aggregate) instead of being reduced client-side
  // from completedTransactions; default empty so tests that don't care
  // about discount numbers specifically still render without crashing.
  mockUseDiscountComplianceReport.mockReturnValue({ data: { data: [] }, isLoading: false });
  // Task: Discount Compliance parity — sources the Customer ID / Reference
  // column via a Map keyed by transaction id, same discount-audit endpoint
  // the Admin drilldown already calls; default empty so tests that don't
  // care about it still render without crashing.
  mockUseDiscountAuditTrail.mockReturnValue({ data: { data: [] }, isLoading: false });
  mockUseReportPeriodSummary.mockReturnValue({ data: periodSummary(), isLoading: false, isError: false });
  mockUseInventoryConsumptionSummaryReport.mockReturnValue({ data: { data: [], total: 0 }, isLoading: false, isError: false, refetch: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openInventoryMovementTab() {
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Inventory Movement' }));
}

describe('ReportsView — Inventory Movement tab (aligned InventoryStockMovement source)', () => {
  it('TEST A — calls the aligned useInventoryStockMovements hook (not the legacy useInventoryMovements hook)', () => {
    render(<ReportsView />);
    openInventoryMovementTab();

    expect(mockUseInventoryStockMovements).toHaveBeenCalledWith('branch-1', expect.objectContaining({ page: 1, limit: 25 }));
  });

  it('TEST B — renders a RECEIVING movement row with before/change/after quantities and unit', () => {
    mockMovements([
      stockMovement({
        id: 'm1',
        inventory_item_name: 'Large Cup',
        movement_type: 'RECEIVING',
        quantity_before: 0,
        quantity_change: 500,
        quantity_after: 500,
        unit_id: 'unit-1',
      }),
    ]);

    render(<ReportsView />);
    openInventoryMovementTab();

    const row = screen.getByText('Large Cup').closest('tr');
    expect(row).not.toBeNull();
    const rowUtils = within(row as HTMLElement);
    expect(rowUtils.getByText('Deliveries / Received')).toBeInTheDocument();
    expect(rowUtils.getByText('0')).toBeInTheDocument();
    expect(rowUtils.getByText('+500')).toBeInTheDocument();
    expect(rowUtils.getByText('500')).toBeInTheDocument();
    expect(rowUtils.getByText('pc')).toBeInTheDocument();
  });

  it('TEST C — renders a SALE movement with a negative quantity change', () => {
    mockMovements([
      stockMovement({
        id: 'm2',
        inventory_item_name: 'Large Cup',
        movement_type: 'SALE',
        quantity_before: 500,
        quantity_change: -1,
        quantity_after: 499,
      }),
    ]);

    render(<ReportsView />);
    openInventoryMovementTab();

    const row = screen.getByText('Large Cup').closest('tr');
    expect(row).not.toBeNull();
    const rowUtils = within(row as HTMLElement);
    expect(rowUtils.getByText('Sale')).toBeInTheDocument();
    expect(rowUtils.getByText('-1')).toBeInTheDocument();
    expect(rowUtils.getByText('499')).toBeInTheDocument();
  });

  it('TEST D — shows a clear empty-history message when no movements are returned', () => {
    mockMovements([]);

    render(<ReportsView />);
    openInventoryMovementTab();

    expect(screen.getByText('No inventory movements')).toBeInTheDocument();
  });

  it('TEST E — shows loading UI without throwing or rendering the empty-state message', () => {
    mockUseInventoryStockMovements.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });

    const { container } = render(<ReportsView />);
    openInventoryMovementTab();

    expect(screen.queryByText('No inventory movements')).not.toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('TEST F — changing the selected branch changes the branch ID passed to useInventoryStockMovements', () => {
    mockBranchState({ activeBranchId: 'branch-1', activeBranch: { id: 'branch-1', name: 'Main Branch' } });
    const { rerender } = render(<ReportsView />);
    expect(mockUseInventoryStockMovements).toHaveBeenCalledWith('branch-1', expect.anything());

    mockBranchState({ activeBranchId: 'branch-2', activeBranch: { id: 'branch-2', name: 'Second Branch' } });
    rerender(<ReportsView />);

    expect(mockUseInventoryStockMovements).toHaveBeenCalledWith('branch-2', expect.anything());
  });
});

function openConsumptionSummaryTab() {
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Stock Used Summary' }));
}

describe('ReportsView — Consumption Summary tab (TASK 209.9 mixed-unit total removal)', () => {
  it('TEST G — never renders a combined quantity total across incompatible units', () => {
    mockConsumption([consumptionRow({ ingredient_name: 'Cheese Flavor', quantity_consumed: 13620, unit: 'g' }), consumptionRow({ ingredient_id: 'item-2', ingredient_name: 'Paper Bag', quantity_consumed: 135, unit: 'pc' })]);

    render(<ReportsView />);
    openConsumptionSummaryTab();

    expect(screen.queryByText('Total Quantity Consumed')).not.toBeInTheDocument();
    expect(screen.queryByText('148.62')).not.toBeInTheDocument();
  });

  it('TEST H — auto-converts a gram quantity at or above 1000g to kg, exactly (13620g -> 13.62 kg)', () => {
    mockConsumption([consumptionRow({ quantity_consumed: 13620, unit: 'g' })]);

    render(<ReportsView />);
    openConsumptionSummaryTab();

    expect(screen.getByText('13.62 kg')).toBeInTheDocument();
  });

  it('TEST I — a sub-1000g quantity stays in grams (999g stays "999 g")', () => {
    mockConsumption([consumptionRow({ quantity_consumed: 999, unit: 'g' })]);

    render(<ReportsView />);
    openConsumptionSummaryTab();

    expect(screen.getByText('999 g')).toBeInTheDocument();
  });

  it('TEST J — count-based (pc) inventory is never converted, stays in its own unit', () => {
    mockConsumption([consumptionRow({ quantity_consumed: 135, unit: 'pc' })]);

    render(<ReportsView />);
    openConsumptionSummaryTab();

    expect(screen.getByText('135 pc')).toBeInTheDocument();
  });

  it('reads the server aggregate only while the tab is open, not the movements on one page', () => {
    render(<ReportsView />);
    expect(mockUseInventoryConsumptionSummaryReport).toHaveBeenLastCalledWith(expect.objectContaining({ branch_id: 'branch-1' }), false);
    openConsumptionSummaryTab();
    expect(mockUseInventoryConsumptionSummaryReport).toHaveBeenLastCalledWith(expect.objectContaining({ branch_id: 'branch-1' }), true);
  });
});

function transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
  return {
    id: 'txn-1',
    receipt_number: 'PC-0001',
    branch_id: 'branch-1',
    shift_id: null,
    cashier_id: 'employee-1',
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
    payment_reference: null,
    has_payment_proof: false,
    payment_proof_type: null,
    payment_proof_uploaded_at: null,
    has_discount_proof: false,
    discount_proof_type: null,
    discount_proof_uploaded_at: null,
    receipt_printed: false,
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
    created_at: '2026-07-30T04:00:00.000Z',
    updated_at: '2026-07-30T04:00:00.000Z',
    items: [
      {
        id: 'item-1',
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        flavor_id: null,
        product_name: 'Regular Fries',
        variant_name: 'Regular',
        flavor_name: null,
        unit_price: 100,
        quantity: 1,
        line_total: 100,
        recipe_version: 1,
        selected_options: [],
      },
    ],
    ...overrides,
  };
}

describe('ReportsView — Reports §8/§9/§10 (shift removal, Sold Product Transactions)', () => {
  it('does not render a Shift Summary tab', () => {
    render(<ReportsView />);
    expect(screen.queryByRole('tab', { name: 'Shift Summary' })).not.toBeInTheDocument();
  });

  it('does not render a Cash Reconciliation tab', () => {
    render(<ReportsView />);
    expect(screen.queryByRole('tab', { name: 'Cash Reconciliation' })).not.toBeInTheDocument();
  });

  it('renders a Sold Product Transactions tab showing a real transaction row', () => {
    mockUseTransactions.mockReturnValue({
      data: { transactions: [transaction()], total: 1, page: 1, limit: 100 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ReportsView />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Sold Product Transactions' }));

    expect(screen.getByText('PC-0001')).toBeInTheDocument();
    expect(screen.getByText('1x Regular Fries')).toBeInTheDocument();
  });

  it('filters Sold Product Transactions by receipt number, on the server', async () => {
    mockUseTransactions.mockReturnValue({
      data: {
        transactions: [transaction({ id: 'txn-1', receipt_number: 'PC-0001' }), transaction({ id: 'txn-2', receipt_number: 'PC-0002' })],
        total: 2,
        page: 1,
        limit: 100,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ReportsView />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Sold Product Transactions' }));
    expect(screen.getByText('PC-0001')).toBeInTheDocument();
    expect(screen.getByText('PC-0002')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search receipt number'), { target: { value: 'PC-0002' } });

    await waitFor(() => expect(mockUseTransactions).toHaveBeenCalledWith(expect.objectContaining({ receipt_search: 'PC-0002', page: 1 })));
  });

  it('TASK 209.10 — export parity: includes the active Sold Product Transactions search filter in the export request', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    mockUseTransactions.mockReturnValue({
      data: { transactions: [transaction()], total: 1, page: 1, limit: 100 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ReportsView />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Sold Product Transactions' }));
    fireEvent.change(screen.getByPlaceholderText('Search receipt number'), { target: { value: 'PC-0002' } });
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ search: 'PC-0002' }) }),
      expect.anything(),
    );
  });

  it('TASK 209.10 — export parity: Daily Sales export request never carries a search filter (Sold Product Transactions state stays scoped to its own tab)', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    mockUseTransactions.mockReturnValue({
      data: { transactions: [transaction()], total: 1, page: 1, limit: 100 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ReportsView />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Sold Product Transactions' }));
    fireEvent.change(screen.getByPlaceholderText('Search receipt number'), { target: { value: 'PC-0002' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Daily Sales Report (DSR)' }));
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ filters: expect.not.objectContaining({ search: 'PC-0002' }) }),
      expect.anything(),
    );
  });
});

describe('ReportsView — export controls (CSV/PDF download fix)', () => {
  it('renders both export buttons with type="button", outside any form', () => {
    render(<ReportsView />);
    const csvButton = screen.getByRole('button', { name: /export csv/i });
    const pdfButton = screen.getByRole('button', { name: /export pdf/i });
    expect(csvButton).toHaveAttribute('type', 'button');
    expect(pdfButton).toHaveAttribute('type', 'button');
    expect(csvButton.closest('form')).toBeNull();
    expect(pdfButton.closest('form')).toBeNull();
  });

  it('calls mutate with only format csv and does not change the PDF button state', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    render(<ReportsView />);

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'csv' }), expect.anything());
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeEnabled();
  });

  it('calls mutate with only format pdf and does not change the CSV button state', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    render(<ReportsView />);

    fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ format: 'pdf' }), expect.anything());
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  it('shows "Exporting CSV…" while pending and disables the button so a rapid second click sends only one request', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    render(<ReportsView />);

    const csvButton = screen.getByRole('button', { name: /export csv/i });
    fireEvent.click(csvButton);
    expect(screen.getByRole('button', { name: 'Exporting CSV…' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Exporting CSV…' }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('does not touch the Refresh cooldown when exporting', () => {
    render(<ReportsView />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect(screen.getByRole('button', { name: /^refresh$/i })).not.toBeDisabled();
  });

  it('resets to idle "Export CSV" (enabled) once the mutation settles', async () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    render(<ReportsView />);

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    const onSettled = mutate.mock.calls.at(-1)?.[1]?.onSettled;
    expect(typeof onSettled).toBe('function');

    await act(async () => {
      onSettled();
    });

    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });
});

// Task: Discount Compliance parity — Customer ID / Reference must be visible
// to both Supervisor and Admin (super_admin) on this tab's detail table,
// sourced from the same discount-audit trail endpoint the Admin drilldown
// already uses (mocked here as mockUseDiscountAuditTrail), not a new query.
describe('ReportsView — Discount Compliance tab Customer ID / Reference column', () => {
  function openDiscountComplianceTab() {
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Discount Report' }));
  }

  function mockDiscountedTransaction(overrides: Partial<TransactionResponse> = {}) {
    mockUseTransactions.mockReturnValue({
      data: {
        transactions: [transaction({ id: 'txn-pwd-1', receipt_number: 'PC-0099', discount_type: 'pwd', discount_amount: 20, ...overrides })],
        total: 1,
        page: 1,
        limit: 100,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
  }

  it('renders the stored Customer ID / Reference for a supervisor viewing a PWD transaction', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
      selector({ user: { id: 'supervisor-1', role: 'supervisor' } }),
    );
    mockDiscountedTransaction();
    mockUseDiscountAuditTrail.mockReturnValue({
      data: { data: [{ id: 'txn-pwd-1', discountCustomerId: '1234567890', discountType: 'pwd' }] },
      isLoading: false,
    });

    render(<ReportsView />);
    openDiscountComplianceTab();

    const row = screen.getByText('PC-0099').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('1234567890')).toBeInTheDocument();
  });

  it('renders the stored Customer ID / Reference for a super_admin viewing a Senior Citizen transaction', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
      selector({ user: { id: 'admin-1', role: 'super_admin' } }),
    );
    mockDiscountedTransaction({ discount_type: 'senior_citizen' });
    mockUseDiscountAuditTrail.mockReturnValue({
      data: { data: [{ id: 'txn-pwd-1', discountCustomerId: 'SC-1234567', discountType: 'senior_citizen' }] },
      isLoading: false,
    });

    render(<ReportsView />);
    openDiscountComplianceTab();

    const row = screen.getByText('PC-0099').closest('tr');
    expect(within(row as HTMLElement).getByText('SC-1234567')).toBeInTheDocument();
  });

  it('renders "—" (never a crash) when the discount-audit trail has no matching row — null/legacy/missing ID', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
      selector({ user: { id: 'supervisor-1', role: 'supervisor' } }),
    );
    mockDiscountedTransaction();
    mockUseDiscountAuditTrail.mockReturnValue({ data: { data: [] }, isLoading: false });

    render(<ReportsView />);
    openDiscountComplianceTab();

    const row = screen.getByText('PC-0099').closest('tr');
    expect(within(row as HTMLElement).getByText('—')).toBeInTheDocument();
  });

  it('does not render the Customer ID / Reference column for a branch/staff session (same PII gate as Proof Available)', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
      selector({ user: { id: 'staff-1', role: 'staff' } }),
    );
    mockDiscountedTransaction();
    mockUseDiscountAuditTrail.mockReturnValue({
      data: { data: [{ id: 'txn-pwd-1', discountCustomerId: '1234567890', discountType: 'pwd' }] },
      isLoading: false,
    });

    render(<ReportsView />);
    openDiscountComplianceTab();

    expect(screen.queryByText('Customer ID / Reference')).not.toBeInTheDocument();
    expect(screen.queryByText('1234567890')).not.toBeInTheDocument();
  });
});

// FAST FIX — Daily Sales report is missing the same Customer ID / Reference
// a supervisor needs for PWD/Senior transactions, and was falling back to a
// raw cashier UUID whenever the client-side employees list didn't have a
// match. Daily Sales is the default tab, so no tab click is needed.
describe('ReportsView — Daily Sales tab Customer ID / Reference and cashier name', () => {
  function mockDailySalesTransaction(overrides: Partial<TransactionResponse> = {}) {
    mockUseTransactions.mockReturnValue({
      data: {
        transactions: [transaction({ id: 'txn-pwd-1', receipt_number: 'PC-0099', discount_type: 'pwd', discount_amount: 20, ...overrides })],
        total: 1,
        page: 1,
        limit: 100,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
  }

  it('renders the stored Customer ID / Reference for a supervisor viewing a PWD transaction', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
      selector({ user: { id: 'supervisor-1', role: 'supervisor' } }),
    );
    mockDailySalesTransaction();
    mockUseDiscountAuditTrail.mockReturnValue({
      data: { data: [{ id: 'txn-pwd-1', discountCustomerId: '1234567890', discountType: 'pwd' }] },
      isLoading: false,
    });

    render(<ReportsView />);

    const row = screen.getByText('PC-0099').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('1234567890')).toBeInTheDocument();
  });

  it('renders "—" for a non-discounted transaction\'s Customer ID / Reference', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
      selector({ user: { id: 'supervisor-1', role: 'supervisor' } }),
    );
    mockDailySalesTransaction({ discount_type: null, discount_amount: 0 });
    mockUseDiscountAuditTrail.mockReturnValue({ data: { data: [] }, isLoading: false });

    render(<ReportsView />);

    const row = screen.getByText('PC-0099').closest('tr');
    // A non-discounted row also shows "—" for Discount Type, so several
    // cells legitimately match — assert at least one exists rather than
    // requiring uniqueness.
    expect(within(row as HTMLElement).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('does not render the Customer ID / Reference column for a branch/staff session', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
      selector({ user: { id: 'staff-1', role: 'staff' } }),
    );
    mockDailySalesTransaction();
    mockUseDiscountAuditTrail.mockReturnValue({
      data: { data: [{ id: 'txn-pwd-1', discountCustomerId: '1234567890', discountType: 'pwd' }] },
      isLoading: false,
    });

    render(<ReportsView />);

    expect(screen.queryByText('Customer ID / Reference')).not.toBeInTheDocument();
    expect(screen.queryByText('1234567890')).not.toBeInTheDocument();
  });

  it('shows the server-resolved cashier_name instead of the raw cashier_id UUID', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
      selector({ user: { id: 'supervisor-1', role: 'supervisor' } }),
    );
    mockUseTransactions.mockReturnValue({
      data: {
        transactions: [
          transaction({ id: 'txn-1', receipt_number: 'PC-0100', cashier_id: '08f7750e-027c-41f6-88de-f49d3a48b8d8', cashier_name: 'CJ Lonzaga' }),
        ],
        total: 1,
        page: 1,
        limit: 100,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ReportsView />);

    const row = screen.getByText('PC-0100').closest('tr');
    expect(within(row as HTMLElement).getByText('CJ Lonzaga')).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText('08f7750e-027c-41f6-88de-f49d3a48b8d8')).not.toBeInTheDocument();
  });

  it('falls back to the cashier_id UUID only when both cashier_name and the employees list are missing a match', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
      selector({ user: { id: 'supervisor-1', role: 'supervisor' } }),
    );
    mockUseTransactions.mockReturnValue({
      data: {
        transactions: [transaction({ id: 'txn-1', receipt_number: 'PC-0101', cashier_id: '08f7750e-027c-41f6-88de-f49d3a48b8d8', cashier_name: null })],
        total: 1,
        page: 1,
        limit: 100,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ReportsView />);

    const row = screen.getByText('PC-0101').closest('tr');
    expect(within(row as HTMLElement).getByText('08f7750e-027c-41f6-88de-f49d3a48b8d8')).toBeInTheDocument();
  });
});

describe('ReportsView — report coverage (POS-PERF-P59)', () => {
  const page = (total: number, rows: TransactionResponse[] = [transaction()]) => ({ data: { transactions: rows, total, page: 1, limit: 25 }, isLoading: false, isError: false, refetch: vi.fn() });
  const fullPeriod = () => periodSummary({ sales: { completed_count: 5000, completed_total_amount: 900000, completed_discount_amount: 1234, voided_count: 60, voided_total_amount: 777, refunded_count: 41, refunded_total_amount: 888 } });

  it('Daily Sales cards read the full-period aggregate, never the sum of the rows on this page', () => {
    mockUseTransactions.mockReturnValue(page(5000));
    mockUseReportPeriodSummary.mockReturnValue({ data: fullPeriod(), isLoading: false, isError: false });
    render(<ReportsView />);

    expect(screen.getByText('5000')).toBeInTheDocument();
    expect(screen.getByText('900000')).toBeInTheDocument();
    expect(screen.getByText('1234')).toBeInTheDocument();
    expect(screen.getByText(/Totals cover all 5,000 completed sales in this period/)).toBeInTheDocument();
    expect(mockUseTransactions).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', page: 1, limit: 25 }));
  });

  it.each([
    [100, null],
    [101, 'PDF holds the newest 100 completed sales, and 101 match'],
    [10_001, 'PDF holds the newest 100 completed sales; CSV holds the newest 10,000 completed sales, and 10,001 match'],
  ])('warns before a Daily Sales export would be cut short: %i sales', (total, expected) => {
    mockUseTransactions.mockReturnValue(page(total));
    render(<ReportsView />);
    if (expected) expect(screen.getByRole('status')).toHaveTextContent(expected);
    else expect(screen.queryByText(/Exports will be partial/)).not.toBeInTheDocument();
  });

  it('a failed aggregate says Unavailable on every card, never a false 0 or a claim about totals', () => {
    mockUseTransactions.mockReturnValue(page(3));
    mockUseReportPeriodSummary.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<ReportsView />);
    expect(screen.getAllByText('Unavailable')).toHaveLength(3);
    expect(screen.queryByText(/Totals cover all/)).not.toBeInTheDocument();
    expect(screen.getByText(/3 completed sales match/)).toBeInTheDocument();
  });

  it('staff: the aggregate is never requested, and their cards say Unavailable', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) => selector({ user: { id: 'staff-1', role: 'staff' } }));
    mockUseTransactions.mockReturnValue(page(3));
    mockUseReportPeriodSummary.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    render(<ReportsView />);
    expect(mockUseReportPeriodSummary).toHaveBeenLastCalledWith(expect.objectContaining({ branch_id: 'branch-1' }), false);
    expect(screen.getAllByText('Unavailable')).toHaveLength(3);
  });

  it('Void/Refund pages one combined list, and its cards read the aggregate', () => {
    mockUseTransactions.mockReturnValue(page(101, [transaction({ id: 'v1', receipt_number: 'V-1', status: 'voided' }), transaction({ id: 'r1', receipt_number: 'R-1', status: 'refunded' })]));
    mockUseReportPeriodSummary.mockReturnValue({ data: fullPeriod(), isLoading: false, isError: false });
    render(<ReportsView />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Void/Refund' }));

    expect(mockUseTransactions).toHaveBeenCalledWith(expect.objectContaining({ status_group: 'void_refund', page: 1, limit: 25 }));
    expect(screen.getByText('777')).toBeInTheDocument();
    expect(screen.getByText('888')).toBeInTheDocument();
    expect(within(screen.getByText('V-1').closest('tr') as HTMLElement).getByText('Void')).toBeInTheDocument();
    expect(within(screen.getByText('R-1').closest('tr') as HTMLElement).getByText('Refund')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('PDF holds the newest 100 voided or refunded sales, and 101 match');
  });

  it('Inventory Movement and Attendance cards read the aggregate, and their tables report the true total', () => {
    mockUseInventoryStockMovements.mockReturnValue({ data: { movements: [], total: 250, page: 1, limit: 25 }, isLoading: false, isError: false, refetch: vi.fn() });
    mockUseAttendanceByBranch.mockReturnValue({ data: { records: [], total: 130, page: 1, limit: 25 }, isLoading: false, isError: false, refetch: vi.fn() });
    mockUseReportPeriodSummary.mockReturnValue({
      data: periodSummary({ movements: { total_count: 250, receiving_count: 11, waste_count: 22, adjustment_count: 33, sale_count: 184 }, attendance: { record_count: 130, open_count: 4, work_minutes: 6000, overtime_minutes: 120 } }),
      isLoading: false,
      isError: false,
    });
    render(<ReportsView />);

    openInventoryMovementTab();
    expect(screen.getByText('250')).toBeInTheDocument();
    expect(screen.getByText('33')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('PDF holds the newest 100 stock movements, and 250 match');

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Attendance Summary' }));
    expect(screen.getByText('Attendance Records')).toBeInTheDocument();
    expect(screen.queryByText('Total Staff Today')).not.toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('PDF holds the newest 100 attendance records, and 130 match');
  });

  it('Daily Sales asks for the customer IDs of exactly this page, so a row on any page finds its own', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) => selector({ user: { id: 'sup-1', role: 'supervisor' } }));
    mockUseTransactions.mockReturnValue(page(200, [transaction({ id: 'd1', discount_type: 'pwd', discount_amount: 5 }), transaction({ id: 'p1', receipt_number: 'PC-2' })]));
    render(<ReportsView />);
    expect(mockUseDiscountAuditTrail).toHaveBeenCalledWith(expect.objectContaining({ transactionIds: ['d1'] }), true);
  });

  it('Sold Product Transactions sends its filters to the server and its export, with its own view', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    mockUseTransactions.mockReturnValue(page(1));
    render(<ReportsView />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Sold Product Transactions' }));
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));

    expect(mockUseTransactions).toHaveBeenCalledWith(expect.not.objectContaining({ status: expect.anything() }));
    expect(mutate.mock.calls[0]?.[0].filters).toMatchObject({ report_view: 'sold_product_transactions' });
  });
});

describe('ReportsView — no visible VAT (POS-PERF-P59)', () => {
  const legacy = transaction({ id: 'L1', receipt_number: 'L1', total_amount: 500, vat_amount: 53.57, discount_type: null, discount_amount: 0 });
  const manual = transaction({ id: 'M1', receipt_number: 'M1', total_amount: 450, calculation_mode: 'manual_total_v1', vat_amount: null, vat_exempt_amount: null, discount_type: null, discount_amount: 0 });

  it('legacy and manual-total sales keep their totals, with no VAT card, column or "Not calculated" message', () => {
    mockUseTransactions.mockReturnValue({ data: { transactions: [legacy, manual], total: 2, page: 1, limit: 100 }, isLoading: false, isError: false, refetch: vi.fn() });
    mockUseReportPeriodSummary.mockReturnValue({ data: periodSummary({ sales: { ...periodSummary().sales, completed_count: 2, completed_total_amount: 950 } }), isLoading: false, isError: false });
    render(<ReportsView />);
    expect(screen.getByText('950')).toBeInTheDocument();
    for (const gone of ['VAT Collected', 'Without VAT Calculation', 'VAT', 'Not calculated', '53.57']) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    expect(document.body.textContent).not.toMatch(/\bVAT\b|Not calculated/);
  });
});

describe('ReportsView — Discount Report (POS-PERF-P59)', () => {
  const customPwd = () =>
    transaction({
      id: 'txn-manual-1',
      receipt_number: 'PC-M1',
      discount_type: 'manual',
      discount_amount: 25,
      calculation_mode: 'manual_total_v1',
      vat_amount: null,
      vat_exempt_amount: null,
      manual_discount: { discount_type_id: '11111111-1111-4111-8111-111111111111', name: 'PWD', amount: 25, require_proof: true },
    });
  const reportRow = (key: string, name: string, count: number, overrides: Record<string, unknown> = {}) => ({
    branch_id: 'branch-1',
    branch_name: 'Main',
    discount_type: key.startsWith('manual') ? 'manual' : key.slice('type:'.length),
    discount_key: key,
    discount_name: name,
    transaction_count: count,
    total_discount_amount: count * 10,
    total_vat_exempt_amount: null,
    proof_required_count: 0,
    proof_available_count: 0,
    proof_missing_count: 0,
    proof_unknown_count: 0,
    ...overrides,
  });

  function asSupervisor() {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) => selector({ user: { id: 'supervisor-1', role: 'supervisor' } }));
  }

  it('a custom type named PWD shows PWD, never the word Manual, on the Daily Sales and Discount tabs', () => {
    asSupervisor();
    mockUseTransactions.mockReturnValue({ data: { transactions: [customPwd()], total: 1, page: 1, limit: 100 }, isLoading: false, isError: false, refetch: vi.fn() });
    render(<ReportsView />);
    expect(within(screen.getByText('PC-M1').closest('tr') as HTMLElement).getByText('PWD')).toBeInTheDocument();
    expect(screen.queryByText('Manual')).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Discount Report' }));
    expect(within(screen.getByText('PC-M1').closest('tr') as HTMLElement).getByText('PWD')).toBeInTheDocument();
    expect(screen.queryByText('Manual')).not.toBeInTheDocument();
  });

  it('a manual sale with no saved name reads Unspecified discount: no guess from the amount or proof', () => {
    mockUseTransactions.mockReturnValue({
      data: { transactions: [transaction({ id: 'old', receipt_number: 'PC-OLD', discount_type: 'manual', discount_amount: 25, has_discount_proof: true, manual_discount: null })], total: 1, page: 1, limit: 100 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<ReportsView />);
    expect(within(screen.getByText('PC-OLD').closest('tr') as HTMLElement).getByText('Unspecified discount')).toBeInTheDocument();
  });

  it('has no fixed PWD/Senior cards, and a historical statutory sale keeps its own label', () => {
    mockUseTransactions.mockReturnValue({
      data: { transactions: [transaction({ id: 's1', receipt_number: 'PC-S1', discount_type: 'senior_citizen', discount_amount: 20 })], total: 1, page: 1, limit: 100 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockUseDiscountComplianceReport.mockReturnValue({ data: { data: [reportRow('type:senior_citizen', 'Senior Citizen', 1)] }, isLoading: false });
    render(<ReportsView />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Discount Report' }));
    expect(screen.getByText('Total Discounted Transactions')).toBeInTheDocument();
    expect(screen.getByText('Total Discount Amount')).toBeInTheDocument();
    expect(screen.queryByText('PWD Discounts')).not.toBeInTheDocument();
    expect(screen.queryByText('Senior Citizen Discounts')).not.toBeInTheDocument();
    expect(within(screen.getByText('PC-S1').closest('tr') as HTMLElement).getByText('Senior Citizen')).toBeInTheDocument();
  });

  it('the type breakdown, its filter and the export all use the discount identity', () => {
    asSupervisor();
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    mockUseDiscountComplianceReport.mockReturnValue({
      data: {
        data: [
          reportRow('manual:aaaaaaaa-1111-4111-8111-111111111111', 'PWD', 2, { discount_other_names: ['PWD 2025'] }),
          reportRow('manual:bbbbbbbb-1111-4111-8111-111111111111', 'Loyalty', 3),
        ],
      },
      isLoading: false,
    });
    render(<ReportsView />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Discount Report' }));

    // Both rows, with the historical name still visible after a rename.
    expect(screen.getByText('PWD')).toBeInTheDocument();
    expect(screen.getByText('Also saved as: PWD 2025')).toBeInTheDocument();
    expect(screen.getByText('Loyalty')).toBeInTheDocument();
    // No hidden server filter yet.
    expect(mockUseTransactions).toHaveBeenCalledWith(expect.objectContaining({ discounted_only: 'true', discount_key: undefined }));

    fireEvent.click(screen.getByRole('combobox', { name: 'Discount Type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Loyalty' }));

    expect(mockUseTransactions).toHaveBeenCalledWith(expect.objectContaining({ discounted_only: 'true', discount_key: 'manual:bbbbbbbb-1111-4111-8111-111111111111' }));
    expect(screen.queryByText('Also saved as: PWD 2025')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /csv/i }));
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ report_type: 'DISCOUNT_COMPLIANCE', filters: { discount_key: 'manual:bbbbbbbb-1111-4111-8111-111111111111' } });
  });

  it('staff: the report API refuses them, so no summary, filter or false ₱0, and the sales they may read still show', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) => selector({ user: { id: 'staff-1', role: 'staff' } }));
    mockUseDiscountComplianceReport.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    mockUseTransactions.mockReturnValue({ data: { transactions: [customPwd()], total: 1, page: 1, limit: 100 }, isLoading: false, isError: false, refetch: vi.fn() });
    render(<ReportsView />);
    expect(mockUseDiscountComplianceReport).toHaveBeenCalledWith(expect.anything(), false);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Discount Report' }));
    expect(screen.queryByText('Total Discounted Transactions')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Discount Type' })).not.toBeInTheDocument();
    expect(within(screen.getByText('PC-M1').closest('tr') as HTMLElement).getByText('PWD')).toBeInTheDocument();
  });

  it('a failed summary says Unavailable, never a false 0', () => {
    mockUseDiscountComplianceReport.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    render(<ReportsView />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Discount Report' }));
    expect(screen.getAllByText('Unavailable')).toHaveLength(2);
  });

  it('only the Discount tab sends the type filter on export', () => {
    const mutate = vi.fn();
    mockUseRequestExport.mockReturnValue({ mutate, isPending: false });
    mockUseDiscountComplianceReport.mockReturnValue({ data: { data: [reportRow('type:pwd', 'PWD', 1)] }, isLoading: false });
    render(<ReportsView />);
    fireEvent.click(screen.getByRole('button', { name: /csv/i }));
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ report_type: 'DAILY_SALES' });
    expect(mutate.mock.calls[0]?.[0].filters.discount_key).toBeUndefined();
  });
});
