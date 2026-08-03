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
