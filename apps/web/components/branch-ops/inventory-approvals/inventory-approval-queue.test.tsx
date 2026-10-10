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
    status: 'PENDING',
    submitted_by_user_id: 'account-1',
    submitted_by_name: 'Branch Account',
    submitted_at: '2026-08-03T02:00:00.000Z',
    reviewed_by_user_id: null,
    reviewed_by_name: null,
    reviewed_at: null,
    return_reason: null,
    applied_movement_id: null,
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
  it('never renders the account submitter — only the PIN-identified Recorded By staff', () => {
    renderWithRequests([
      request({
        submitted_by_name: 'Branch Account',
        responsible_staff_name: 'Juan Dela Cruz',
        pin_verified_at: '2026-08-03T02:00:00.000Z',
      }),
    ]);

    expect(screen.queryByText('Branch Account')).not.toBeInTheDocument();
    expect(screen.queryByText('Submitted By (Account)')).not.toBeInTheDocument();

    const row = within(dataRow());
    expect(row.getByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(row.getByText('PIN Verified')).toBeInTheDocument();
  });

  it('has no duplicate Responsible Staff / Recorded By columns', () => {
    renderWithRequests([
      request({
        responsible_staff_name: 'Juan Dela Cruz',
        pin_verified_at: '2026-08-03T02:00:00.000Z',
      }),
    ]);

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.filter((h) => h === 'Recorded By')).toHaveLength(1);
    expect(headers).not.toContain('Responsible Staff');
  });

  it('shows Not recorded with a dash badge when no responsible staff identity exists — never falls back to the submitter', () => {
    renderWithRequests([
      request({ responsible_staff_name: null, pin_verified_at: null, submitted_by_name: 'Branch Account' }),
    ]);

    const row = within(dataRow());
    expect(row.getByText('Not recorded')).toBeInTheDocument();
    expect(row.getByText('—')).toBeInTheDocument();
    expect(row.queryByText('Branch Account')).not.toBeInTheDocument();
  });

  it('labels a present staff name as Not PIN verified when the verification timestamp is missing', () => {
    renderWithRequests([request({ responsible_staff_name: 'Pedro Reyes', pin_verified_at: null })]);

    const row = within(dataRow());
    expect(row.getByText('Pedro Reyes')).toBeInTheDocument();
    expect(row.getByText('Not PIN verified')).toBeInTheDocument();
    expect(row.queryByText('PIN Verified')).not.toBeInTheDocument();
  });

  it('renders a long responsible staff name in full', () => {
    renderWithRequests([
      request({
        responsible_staff_name: 'Maria Concepcion Dela Cruz-Santos Bautista',
        pin_verified_at: '2026-08-03T02:00:00.000Z',
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
    expect(row.getByText('Juan Dela Cruz')).toBeInTheDocument();
  });

  it('keeps the filter tabs, Review action, and other columns unaffected by identity rendering', () => {
    renderWithRequests([
      request({
        responsible_staff_name: 'Juan Dela Cruz',
        pin_verified_at: '2026-08-03T02:00:00.000Z',
      }),
    ]);

    expect(screen.getByRole('tab', { name: 'Pending Review' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Approved' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Returned for Correction' })).toBeInTheDocument();

    const row = within(dataRow());
    expect(row.getByText('Potato Flakes')).toBeInTheDocument();
    expect(row.getByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(row.getByText('PIN Verified')).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });
});
