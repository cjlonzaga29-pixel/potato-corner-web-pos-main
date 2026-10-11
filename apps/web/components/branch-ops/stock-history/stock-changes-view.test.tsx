import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StockChangesView } from './stock-changes-view';

/** Same jsdom-friendly native-<select> stand-in used by other Select-based form tests in this repo (see app/(admin)/admin/inventory/movements/page.test.tsx). */
vi.mock('@/components/ui/select', () => {
  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    return <option value={value}>{children}</option>;
  }
  function SelectContent({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectTrigger({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectValue() {
    return null;
  }
  let selectCount = 0;
  function Select({ value, onValueChange, children }: { value?: string; onValueChange?: (value: string) => void; children?: React.ReactNode }) {
    const label = React.useMemo(() => `select-${selectCount++}`, []);
    let options: React.ReactNode = null;
    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child) && child.type === SelectContent) {
        options = (child.props as { children?: React.ReactNode }).children;
      }
    });
    return (
      <select aria-label={label} value={value ?? ''} onChange={(e) => onValueChange?.(e.target.value)}>
        {options}
      </select>
    );
  }
  return { Select, SelectTrigger, SelectContent, SelectItem, SelectValue };
});

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
    inventory_item_id: 'item-1',
    inventory_item_name: 'Cheese Powder',
    movement_type: 'RECEIVING',
    quantity_change: 5,
    quantity_before: 10,
    quantity_after: 15,
    unit_id: 'unit-1',
    unit_code: 'kg',
    reference_type: null,
    reference_id: null,
    notes: null,
    performed_by_user_id: 'user-1',
    unit_cost: null,
    total_cost: null,
    responsible_user_id: null,
    entered_quantity: null,
    entered_unit_id: null,
    entered_unit_code: null,
    performed_by_name: 'Juan Dela Cruz',
    performed_by_role: 'branch',
    responsible_user_name: null,
    receipt_number: null,
    recorded_as_supervisor_direct: false,
    responsible_staff_name: null,
    pin_verified_at: null,
    linked_request_id: null,
    reviewed_by_name: null,
    proof_url: null,
    created_at: '2026-10-08T02:00:00.000Z',
    ...overrides,
  };
}

function setup(data: { movements: unknown[]; total: number }, extra: Record<string, unknown> = {}) {
  mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId: BRANCH_ID }));
  mockUseBranchInventoryStock.mockReturnValue({ data: { items: [] } });
  mockUseInventoryStockMovements.mockReturnValue({
    data: { ...data, page: 1, limit: 25 },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
    ...extra,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StockChangesView', () => {
  it('requests no category by default — "All" means every movement type, not a restricted bucket', () => {
    setup({ movements: [], total: 0 });

    render(<StockChangesView />);

    expect(mockUseInventoryStockMovements).toHaveBeenCalledWith(BRANCH_ID, expect.objectContaining({ category: undefined }));
  });

  it('sends the mapped category when a named filter is selected', () => {
    setup({ movements: [], total: 0 });
    render(<StockChangesView />);

    const categorySelect = screen.getAllByRole('combobox')[1];
    if (!categorySelect) throw new Error('expected a second combobox for the category filter');
    fireEvent.change(categorySelect, { target: { value: 'waste' } });

    expect(mockUseInventoryStockMovements).toHaveBeenLastCalledWith(BRANCH_ID, expect.objectContaining({ category: 'waste' }));
  });

  it('shows the before/after balance, a linked request reference, and the reviewer — never fabricating any of them for a direct record', () => {
    setup({
      movements: [
        movement({ id: 'm-linked', linked_request_id: 'req-abc12345', reviewed_by_name: 'Supe Visor' }),
        movement({ id: 'm-direct', recorded_as_supervisor_direct: true, linked_request_id: null, quantity_before: 20, quantity_after: 25 }),
      ],
      total: 2,
    });

    render(<StockChangesView />);

    expect(screen.getByText('10 → 15 kg')).toBeInTheDocument();
    expect(screen.getByText(/Request #req-abc1/)).toBeInTheDocument();
    expect(screen.getByText('Supe Visor')).toBeInTheDocument();
    expect(screen.getByText('Direct record — no review required')).toBeInTheDocument();
  });

  it('shows an Updating indicator while refetching already-loaded data, not a blank reload', () => {
    setup({ movements: [movement()], total: 1 }, { isFetching: true });

    render(<StockChangesView />);

    expect(screen.getByText('Updating…')).toBeInTheDocument();
    expect(screen.getByText('Cheese Powder')).toBeInTheDocument();
  });

  it('prompts to select a branch instead of rendering the table when none is active', () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId: null }));
    mockUseBranchInventoryStock.mockReturnValue({ data: { items: [] } });
    mockUseInventoryStockMovements.mockReturnValue({ data: undefined, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() });

    render(<StockChangesView />);

    expect(screen.getByText(/Select an active branch/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
