import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import type { InventoryStockMovementResponse, UnitOfMeasureResponse, InventoryItemResponse } from '@potato-corner/shared';
import { ReportsView } from './reports-view';

const {
  mockUseBranchStore,
  mockUseShifts,
  mockUseShiftsRealtimeSync,
  mockUseTransactions,
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
  mockUseShifts: vi.fn(),
  mockUseShiftsRealtimeSync: vi.fn(),
  mockUseTransactions: vi.fn(),
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

vi.mock('@/hooks/queries/use-shifts', () => ({
  useShifts: mockUseShifts,
  useShiftsRealtimeSync: mockUseShiftsRealtimeSync,
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransactions: mockUseTransactions,
  useTransactionsRealtimeSync: mockUseTransactionsRealtimeSync,
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
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: mockUseAuthStore,
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useRequestExport: mockUseRequestExport,
  useReportsRealtimeSync: mockUseReportsRealtimeSync,
}));

/** Swaps Framer Motion's async NumberTicker for a synchronous text node — same approach as the supervisor/admin reports page tests. */
vi.mock('@/components/shared/charts/kpi-card', () => ({
  KpiCard: ({ title, value, isLoading }: { title: string; value: number; isLoading?: boolean }) => (
    <div>
      <span>{title}</span>
      <span>{isLoading ? 'loading' : String(value)}</span>
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
  mockUseShiftsRealtimeSync.mockReturnValue(undefined);
  mockUseTransactionsRealtimeSync.mockReturnValue(undefined);
  mockUseInventoryStockRealtimeSync.mockReturnValue(undefined);
  mockUseAttendanceRealtimeSync.mockReturnValue(undefined);
  mockUseShifts.mockReturnValue({ data: { shifts: [], total: 0, page: 1, limit: 100 }, isLoading: false, isError: false, refetch: vi.fn() });
  mockUseTransactions.mockReturnValue({
    data: { transactions: [], total: 0, page: 1, limit: 100 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockMovements([]);
  mockUseUnitsOfMeasure.mockReturnValue({ data: [unitOfMeasure()], isLoading: false });
  mockUseInventoryItems.mockReturnValue({ data: [inventoryItem()], isLoading: false });
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

function openInventoryMovementTab() {
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Inventory Movement' }));
}

describe('ReportsView — Inventory Movement tab (aligned InventoryStockMovement source)', () => {
  it('TEST A — calls the aligned useInventoryStockMovements hook (not the legacy useInventoryMovements hook)', () => {
    render(<ReportsView />);
    openInventoryMovementTab();

    expect(mockUseInventoryStockMovements).toHaveBeenCalledWith('branch-1', expect.objectContaining({ page: 1, limit: 100 }));
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
    expect(rowUtils.getByText('RECEIVING')).toBeInTheDocument();
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
    expect(rowUtils.getByText('SALE')).toBeInTheDocument();
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
