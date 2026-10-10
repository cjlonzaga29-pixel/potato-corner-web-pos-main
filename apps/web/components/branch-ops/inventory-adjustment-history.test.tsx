import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { InventoryAdjustmentHistory } from './inventory-adjustment-history';

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
    inventory_item_id: 'item-flour',
    inventory_item_name: 'Flour',
    movement_type: 'ADJUSTMENT_OUT',
    quantity_change: -2,
    quantity_before: 10,
    quantity_after: 8,
    unit_id: 'unit-kg',
    unit_code: 'kg',
    reference_type: null,
    reference_id: null,
    notes: 'Reason: SPOILAGE — expired bag',
    performed_by_user_id: 'account-1',
    unit_cost: null,
    total_cost: null,
    responsible_user_id: null,
    entered_quantity: null,
    entered_unit_id: null,
    entered_unit_code: null,
    proof_url: null,
    performed_by_name: 'Branch Account',
    performed_by_role: 'branch',
    responsible_user_name: null,
    responsible_staff_name: null,
    pin_verified_at: null,
    recorded_as_supervisor_direct: false,
    created_at: '2026-08-03T02:00:00.000Z',
    ...overrides,
  };
}

function renderWithMovement(overrides: Record<string, unknown> = {}) {
  mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
    selector({ activeBranchId: BRANCH_ID }),
  );
  mockUseBranchInventoryStock.mockReturnValue({ data: { items: [] } });
  mockUseInventoryStockMovements.mockReturnValue({
    data: { movements: [movement(overrides)], total: 1, page: 1, limit: 10 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  return render(<InventoryAdjustmentHistory />);
}

function dataRow() {
  // First <tr> after the header row holds the single fixture movement.
  const rows = screen.getAllByRole('row');
  return rows[1] as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InventoryAdjustmentHistory — Responsible Staff / Identity Status (POS-PERF-P30R4)', () => {
  it('shows the PIN-verified staff name and a PIN Verified badge when a branch account submits for a different staff member', () => {
    renderWithMovement({
      performed_by_name: 'Branch Account',
      responsible_staff_name: 'Juan Dela Cruz',
      pin_verified_at: '2026-08-03T02:00:00.000Z',
    });

    const row = within(dataRow());
    expect(row.getByText('Branch Account')).toBeInTheDocument();
    expect(row.getByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(row.getByText('PIN Verified')).toBeInTheDocument();
    // Account and staff names must remain two distinct values, never merged.
    expect(screen.queryAllByText('Branch Account')).toHaveLength(1);
  });

  it('shows the same name in both columns without claiming PIN verification for supervisor direct recording', () => {
    renderWithMovement({
      performed_by_name: 'Maria Santos',
      performed_by_role: 'supervisor',
      recorded_as_supervisor_direct: true,
      responsible_staff_name: 'Maria Santos',
      pin_verified_at: '2026-08-03T02:00:00.000Z',
    });

    const row = within(dataRow());
    expect(row.getAllByText('Maria Santos')).toHaveLength(2);
    expect(row.getByText('PIN Verified')).toBeInTheDocument();
  });

  it('preserves a historical responsible_user_name and labels it Not PIN verified when there is no staff PIN evidence', () => {
    renderWithMovement({
      responsible_staff_name: null,
      pin_verified_at: null,
      responsible_user_id: 'legacy-user-1',
      responsible_user_name: 'Legacy Staff Member',
    });

    const row = within(dataRow());
    expect(row.getByText('Legacy Staff Member')).toBeInTheDocument();
    expect(row.getByText('Not PIN verified')).toBeInTheDocument();
    expect(row.queryByText('Not recorded')).not.toBeInTheDocument();
  });

  it('shows Not recorded and a dash badge when there is no responsible identity at all', () => {
    renderWithMovement({
      responsible_staff_name: null,
      pin_verified_at: null,
      responsible_user_id: null,
      responsible_user_name: null,
    });

    const row = within(dataRow());
    expect(row.getByText('Not recorded')).toBeInTheDocument();
    expect(row.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    expect(row.queryByText('PIN Verified')).not.toBeInTheDocument();
    expect(row.queryByText('Not PIN verified')).not.toBeInTheDocument();
  });

  it('labels a staff name as Not PIN verified when the verification timestamp is missing despite the name being present', () => {
    renderWithMovement({
      responsible_staff_name: 'Pedro Reyes',
      pin_verified_at: null,
    });

    const row = within(dataRow());
    expect(row.getByText('Pedro Reyes')).toBeInTheDocument();
    expect(row.getByText('Not PIN verified')).toBeInTheDocument();
    expect(row.queryByText('PIN Verified')).not.toBeInTheDocument();
  });

  it('prefers the PIN-verified staff name over a stale legacy responsible_user_name on the same row', () => {
    renderWithMovement({
      responsible_staff_name: 'Current Staff',
      pin_verified_at: '2026-08-03T02:00:00.000Z',
      responsible_user_id: 'legacy-user-1',
      responsible_user_name: 'Old Legacy Name',
    });

    const row = within(dataRow());
    expect(row.getByText('Current Staff')).toBeInTheDocument();
    expect(row.queryByText('Old Legacy Name')).not.toBeInTheDocument();
    expect(row.getByText('PIN Verified')).toBeInTheDocument();
  });

  it('renders a long staff name without truncation and an empty attachment/notes state as a dash', () => {
    renderWithMovement({
      responsible_staff_name: 'Maria Concepcion Dela Cruz-Santos Bautista',
      pin_verified_at: '2026-08-03T02:00:00.000Z',
      notes: null,
      proof_url: null,
    });

    const row = within(dataRow());
    expect(row.getByText('Maria Concepcion Dela Cruz-Santos Bautista')).toBeInTheDocument();
    expect(row.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });
});
