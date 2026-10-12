import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { InventoryApprovalQueue } from './inventory-approval-queue';

const { mockUseBranchStore, mockUseInventoryApprovals, mockUseInventoryApprovalRealtimeSync } = vi.hoisted(() => ({
  mockUseBranchStore: vi.fn(),
  mockUseInventoryApprovals: vi.fn(),
  mockUseInventoryApprovalRealtimeSync: vi.fn(),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/hooks/queries/use-inventory-approvals', () => ({
  useInventoryApprovals: mockUseInventoryApprovals,
  useInventoryApprovalRealtimeSync: mockUseInventoryApprovalRealtimeSync,
}));

// The detail dialog pulls in its own hook tree (approve/return/correct/
// cancel mutations); irrelevant to the queue's own column rendering, so it
// is stubbed out the same way other suites isolate nested data-fetching
// components.
vi.mock('./inventory-approval-detail-dialog', () => ({
  InventoryApprovalDetailDialog: () => null,
}));

const BRANCH_ID = '123e4567-e89b-12d3-a456-426614174000';

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    root_request_id: 'req-1',
    previous_request_id: null,
    revision_number: 1,
    batch_id: null,
    target: 'UNIVERSAL_ITEM',
    branch_id: BRANCH_ID,
    branch_name: 'Branch A',
    inventory_item_id: 'item-1',
    legacy_ingredient_id: null,
    item_name: 'Potato Flakes',
    item_unit_code: 'kg',
    operation: 'ADJUSTMENT',
    entered_quantity: null,
    entered_unit_id: null,
    total_cost: null,
    delivery_reference: null,
    quantity_delta: -5,
    counted_quantity: null,
    quantity_on_hand_at_submission: 20,
    reason_code: 'SPOILAGE',
    notes: null,
    proof_url: null,
    responsible_staff_user_id: null,
    responsible_staff_name: null,
    pin_verified_at: null,
    staff_involved_name: null,
    status: 'PENDING',
    submitted_by_user_id: 'account-1',
    submitted_by_name: 'Branch Account',
    submitted_at: '2026-08-03T02:00:00.000Z',
    reviewed_by_user_id: null,
    reviewed_by_name: null,
    reviewed_at: null,
    return_reason: null,
    applied_movement_id: null,
    stock_changed: false,
    cancelled_by_user_id: null,
    cancelled_by_name: null,
    cancelled_at: null,
    cancel_reason: null,
    ...overrides,
  };
}

function renderWithRequests(requests: Record<string, unknown>[], status = 'PENDING') {
  mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
    selector({ activeBranchId: BRANCH_ID }),
  );
  mockUseInventoryApprovals.mockReturnValue({
    data: { requests, total: requests.length, page: 1, limit: 25 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  return render(<InventoryApprovalQueue basePath={`/${status.toLowerCase()}`} />);
}

function dataRow() {
  const rows = screen.getAllByRole('row');
  return rows[1] as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InventoryApprovalQueue — Recorded By / Identity Status', () => {
  // POS-PERF-P33 — "Recorded By" is now the authenticated submitting
  // account (never a shared generic login under the new supervisor-managed
  // policy); the PIN-identified name is a separate "Identity Status" badge
  // keyed off responsible_staff_name/pin_verified_at.
  // POS-PERF-P33R — staff_involved_name is a distinct, never-verified
  // free-text column ("Staff Involved (reported)") — never conflated with
  // responsible_staff_name.
  it('shows the submitting account as Recorded By and the PIN-identified name with a PIN Verified badge', () => {
    renderWithRequests([
      request({
        submitted_by_name: 'Maria Santos',
        responsible_staff_name: 'Juan Dela Cruz',
        pin_verified_at: '2026-08-03T02:00:00.000Z',
      }),
    ]);

    const row = within(dataRow());
    expect(row.getByText('Maria Santos')).toBeInTheDocument();
    expect(row.getByText('PIN Verified')).toBeInTheDocument();
  });

  it('has no duplicate Recorded By columns, and a distinct Staff Involved (reported) column', () => {
    renderWithRequests([
      request({
        responsible_staff_name: 'Juan Dela Cruz',
        pin_verified_at: '2026-08-03T02:00:00.000Z',
        staff_involved_name: 'Reported Person',
      }),
    ]);

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.filter((h) => h === 'Recorded By')).toHaveLength(1);
    expect(headers.filter((h) => h === 'Staff Involved (reported)')).toHaveLength(1);
  });

  it('shows Not recorded for Recorded By when the submitting account is missing, and a dash for Staff Involved (reported) when no free-text attribution exists', () => {
    renderWithRequests([request({ submitted_by_name: null, responsible_staff_name: null, pin_verified_at: null, staff_involved_name: null })]);

    const row = within(dataRow());
    expect(row.getByText('Not recorded')).toBeInTheDocument();
    expect(row.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('labels a present staff name as Not PIN verified when the verification timestamp is missing', () => {
    renderWithRequests([request({ responsible_staff_name: 'Pedro Reyes', pin_verified_at: null })]);

    const row = within(dataRow());
    expect(row.getByText('Not PIN verified')).toBeInTheDocument();
    expect(row.queryByText('PIN Verified')).not.toBeInTheDocument();
  });

  it('renders a long staff_involved_name in full in its own column', () => {
    renderWithRequests([
      request({
        staff_involved_name: 'Maria Concepcion Dela Cruz-Santos Bautista',
      }),
    ]);

    expect(screen.getByText('Maria Concepcion Dela Cruz-Santos Bautista')).toBeInTheDocument();
  });

  it('shows Reviewed By (not Submitted By) for the approving supervisor on the Approved tab', () => {
    renderWithRequests([
      request({
        status: 'APPROVED',
        reviewed_by_user_id: 'sup-1',
        reviewed_by_name: 'Supervisor Reyes',
        reviewed_at: '2026-08-03T03:00:00.000Z',
        responsible_staff_name: 'Juan Dela Cruz',
        pin_verified_at: '2026-08-03T02:00:00.000Z',
      }),
    ]);

    // Radix Tabs activates on pointerdown/mousedown, not click.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Approved' }));

    expect(screen.getByRole('columnheader', { name: 'Reviewed By' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Approved By' })).not.toBeInTheDocument();
    const row = within(dataRow());
    expect(row.getByText('Supervisor Reyes')).toBeInTheDocument();
    expect(row.getByText('PIN Verified')).toBeInTheDocument();
  });

  it('keeps the filter tabs, Review action, and other columns unaffected by identity rendering', () => {
    renderWithRequests([
      request({
        responsible_staff_name: 'Juan Dela Cruz',
        pin_verified_at: '2026-08-03T02:00:00.000Z',
        staff_involved_name: 'Reported Person',
      }),
    ]);

    expect(screen.getByRole('tab', { name: 'Pending Review' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Approved' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Returned for Correction' })).toBeInTheDocument();

    const row = within(dataRow());
    expect(row.getByText('Potato Flakes')).toBeInTheDocument();
    expect(row.getByText('Reported Person')).toBeInTheDocument();
    expect(row.getByText('PIN Verified')).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });
});

describe('InventoryApprovalQueue — Stock Change column', () => {
  // POS-PERF-P31R — must read the server-computed stock_changed flag, never
  // re-derive "did this change stock" from applied_movement_id's truthiness
  // or its equality with the request's own id (the zero-variance
  // placeholder) on the client.
  it('shows "Applied" only when stock_changed is true', () => {
    renderWithRequests([
      request({ status: 'APPROVED', applied_movement_id: 'movement-1', stock_changed: true }),
    ]);
    const row = within(dataRow());
    expect(row.getByText('Applied')).toBeInTheDocument();
  });

  it('shows "No quantity change" for an APPROVED request with stock_changed false (zero-variance physical count)', () => {
    renderWithRequests([
      request({
        status: 'APPROVED',
        operation: 'PHYSICAL_COUNT',
        applied_movement_id: 'req-1', // the documented placeholder: equals the request's own id
        stock_changed: false,
      }),
    ]);
    const row = within(dataRow());
    expect(row.getByText('No quantity change')).toBeInTheDocument();
    expect(row.queryByText('Applied')).not.toBeInTheDocument();
  });

  it('shows "No stock change" for a non-APPROVED request regardless of any applied_movement_id value', () => {
    renderWithRequests([request({ status: 'RETURNED', applied_movement_id: null, stock_changed: false })]);
    const row = within(dataRow());
    expect(row.getByText('No stock change')).toBeInTheDocument();
  });
});
