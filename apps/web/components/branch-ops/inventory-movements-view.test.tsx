import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { InventoryMovementsView } from './inventory-movements-view';

const { mockUseBranchStore, mockUseBranchInventoryStock, mockUseInventoryStockMovements } = vi.hoisted(() => ({
  mockUseBranchStore: vi.fn(),
  mockUseBranchInventoryStock: vi.fn(),
  mockUseInventoryStockMovements: vi.fn(),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useBranchInventoryStock: mockUseBranchInventoryStock,
  useInventoryStockMovements: mockUseInventoryStockMovements,
}));

// POS-PERF-P25 — the "Proof of Payment" column's View Photo action opens
// ViewPaymentProofDialog, which calls usePaymentProof (react-query) even
// while closed (transactionId null just means the query stays disabled).
// Mocked the same way the other data hooks above are, so this file never
// needs a real QueryClientProvider wrapper.
vi.mock('@/hooks/queries/use-transactions', () => ({
  usePaymentProof: () => ({ data: undefined, isLoading: false, isError: false }),
}));

const BRANCH_ID = '123e4567-e89b-12d3-a456-426614174000';

function movement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'movement-1',
    branch_id: BRANCH_ID,
    inventory_item_id: 'item-cheese-topping',
    inventory_item_name: 'Cheese Flavor Powder',
    movement_type: 'SALE',
    quantity_change: -1.5,
    quantity_before: 10,
    quantity_after: 8.5,
    unit_id: 'unit-tbsp',
    unit_code: 'tbsp',
    reference_type: 'transaction',
    reference_id: 'txn-1',
    notes: null,
    performed_by_user_id: null,
    unit_cost: null,
    total_cost: null,
    entered_quantity: null,
    entered_unit_code: null,
    performed_by_name: null,
    responsible_user_name: null,
    proof_url: null,
    created_at: '2026-08-03T02:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InventoryMovementsView — quantity + unit display', () => {
  it('renders a fractional deduction with its unit, not a bare truncated number', () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: BRANCH_ID }),
    );
    mockUseBranchInventoryStock.mockReturnValue({ data: { items: [] } });
    mockUseInventoryStockMovements.mockReturnValue({
      data: { movements: [movement()], total: 1, page: 1, limit: 25 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<InventoryMovementsView />);

    expect(screen.getByText('-1.5 tbsp')).toBeInTheDocument();
    expect(screen.getByText('8.5 tbsp')).toBeInTheDocument();
  });

  it('falls back to a bare number when the movement has no unit', () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: BRANCH_ID }),
    );
    mockUseBranchInventoryStock.mockReturnValue({ data: { items: [] } });
    mockUseInventoryStockMovements.mockReturnValue({
      data: { movements: [movement({ unit_id: null, unit_code: null })], total: 1, page: 1, limit: 25 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<InventoryMovementsView />);

    expect(screen.getByText('-1.5')).toBeInTheDocument();
    expect(screen.getByText('8.5')).toBeInTheDocument();
  });
});

// POS-PERF-P25 — "Proof of Payment" (View Photo) and the Reference column's
// receipt-number display, for a SALE movement.
describe('InventoryMovementsView — Proof of Payment and receipt reference (POS-PERF-P25)', () => {
  function renderWithMovement(overrides: Record<string, unknown> = {}) {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: BRANCH_ID }),
    );
    mockUseBranchInventoryStock.mockReturnValue({ data: { items: [] } });
    mockUseInventoryStockMovements.mockReturnValue({
      data: { movements: [movement(overrides)], total: 1, page: 1, limit: 25 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    return render(<InventoryMovementsView />);
  }

  it('shows the receipt number (not a bare id) and a "View Photo" action for a SALE movement', () => {
    renderWithMovement({ receipt_number: 'PC-001-20261008-000123' });

    expect(screen.getByText('PC-001-20261008-000123')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PC-001-20261008-000123' })).toHaveAttribute('href', '/r/PC-001-20261008-000123');
    expect(screen.getByRole('button', { name: 'View Photo' })).toBeInTheDocument();
  });

  it('shows no "View Photo" action for a non-sale movement', () => {
    renderWithMovement({
      movement_type: 'ADJUSTMENT_OUT',
      reference_type: null,
      reference_id: null,
      receipt_number: null,
    });

    expect(screen.queryByRole('button', { name: 'View Photo' })).not.toBeInTheDocument();
  });

  it('falls back to the truncated reference id when no receipt_number was resolved', () => {
    renderWithMovement({ receipt_number: null });

    expect(screen.getByText(/transaction: txn-1/)).toBeInTheDocument();
  });
});

// INVENTORY AUDIT FOLLOW-UPS §3A — the Admin cross-branch screen passes an
// explicit branchId prop, since it has no useBranchStore "active branch" of
// its own; every other caller (Supervisor/Branch chrome) omits the prop and
// must see byte-identical behavior to before this prop existed.
describe('InventoryMovementsView — branchId prop override', () => {
  it('queries movements for the prop branchId, ignoring the store, when branchId is passed', () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: 'store-branch-id' }),
    );
    mockUseBranchInventoryStock.mockReturnValue({ data: { items: [] } });
    mockUseInventoryStockMovements.mockReturnValue({
      data: { movements: [], total: 0, page: 1, limit: 25 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<InventoryMovementsView branchId="admin-picked-branch-id" />);

    expect(mockUseBranchInventoryStock).toHaveBeenCalledWith('admin-picked-branch-id');
    expect(mockUseInventoryStockMovements).toHaveBeenCalledWith('admin-picked-branch-id', expect.anything());
  });

  it('falls back to the store\'s active branch when branchId is omitted (unchanged default behavior)', () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: BRANCH_ID }),
    );
    mockUseBranchInventoryStock.mockReturnValue({ data: { items: [] } });
    mockUseInventoryStockMovements.mockReturnValue({
      data: { movements: [], total: 0, page: 1, limit: 25 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<InventoryMovementsView />);

    expect(mockUseBranchInventoryStock).toHaveBeenCalledWith(BRANCH_ID);
  });
});
