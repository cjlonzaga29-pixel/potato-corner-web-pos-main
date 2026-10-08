import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { OrderDeductionsView } from './order-deductions-view';

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
    entered_unit_id: null,
    entered_unit_code: null,
    performed_by_name: 'Jane Cashier',
    responsible_user_name: 'Jane Cashier',
    proof_url: null,
    receipt_number: 'PC-001-20261008-000123',
    created_at: '2026-10-08T02:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrderDeductionsView — category scoping and labeling', () => {
  it('requests only the order_deductions category, never a bare movement_type by default', () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId: BRANCH_ID }));
    mockUseBranchInventoryStock.mockReturnValue({ data: { items: [] } });
    mockUseInventoryStockMovements.mockReturnValue({ data: { movements: [], total: 0, page: 1, limit: 25 }, isLoading: false, isError: false, refetch: vi.fn() });

    render(<OrderDeductionsView />);

    expect(mockUseInventoryStockMovements).toHaveBeenCalledWith(
      BRANCH_ID,
      expect.objectContaining({ category: 'order_deductions', movement_type: undefined }),
      expect.objectContaining({ refetchInterval: expect.any(Number) }),
    );
  });

  it('shows a single Order Reference + working View Receipt action for a SALE row, no blank/duplicated reference columns', () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId: BRANCH_ID }));
    mockUseBranchInventoryStock.mockReturnValue({ data: { items: [] } });
    mockUseInventoryStockMovements.mockReturnValue({
      data: { movements: [movement()], total: 1, page: 1, limit: 25 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<OrderDeductionsView />);

    expect(screen.getByText('PC-001-20261008-000123')).toBeInTheDocument();
    const receiptLink = screen.getByRole('link', { name: 'View Receipt' });
    expect(receiptLink).toHaveAttribute('href', '/r/PC-001-20261008-000123');
  });

  it('labels a SALE_REVERSAL row "Stock Returned", not a raw enum/different label', () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId: BRANCH_ID }));
    mockUseBranchInventoryStock.mockReturnValue({ data: { items: [] } });
    mockUseInventoryStockMovements.mockReturnValue({
      data: { movements: [movement({ id: 'reversal-1', movement_type: 'SALE_REVERSAL', quantity_change: 1.5 })], total: 1, page: 1, limit: 25 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<OrderDeductionsView />);

    expect(screen.getByText('Stock Returned')).toBeInTheDocument();
    expect(screen.queryByText('SALE_REVERSAL')).not.toBeInTheDocument();
  });

  it('never shows a Purchase Qty/Unit column', () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId: BRANCH_ID }));
    mockUseBranchInventoryStock.mockReturnValue({ data: { items: [] } });
    mockUseInventoryStockMovements.mockReturnValue({ data: { movements: [movement()], total: 1, page: 1, limit: 25 }, isLoading: false, isError: false, refetch: vi.fn() });

    render(<OrderDeductionsView />);

    expect(screen.queryByText('Purchase Qty/Unit')).not.toBeInTheDocument();
  });
});
