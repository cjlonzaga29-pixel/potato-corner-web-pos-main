import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { InventoryApprovalDetailDialog } from './inventory-approval-detail-dialog';

const {
  mockUseAuthStore,
  mockUseInventoryApprovalDetail,
  mockUseApprove,
  mockUseReturn,
  mockUseCorrect,
  mockUseCancel,
} = vi.hoisted(() => ({
  mockUseAuthStore: vi.fn(),
  mockUseInventoryApprovalDetail: vi.fn(),
  mockUseApprove: vi.fn(),
  mockUseReturn: vi.fn(),
  mockUseCorrect: vi.fn(),
  mockUseCancel: vi.fn(),
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: mockUseAuthStore,
}));

vi.mock('@/hooks/queries/use-inventory-approvals', () => ({
  useInventoryApprovalDetail: mockUseInventoryApprovalDetail,
  useApproveInventoryApprovalRequest: mockUseApprove,
  useReturnInventoryApprovalRequest: mockUseReturn,
  useCorrectInventoryApprovalRequest: mockUseCorrect,
  useCancelInventoryApprovalRequest: mockUseCancel,
}));

const BRANCH_ID = '123e4567-e89b-12d3-a456-426614174000';

function detail(overrides: Record<string, unknown> = {}) {
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
    revisions: [{ id: 'rev-1', revision_number: 1, status: 'PENDING', return_reason: null, cancel_reason: null }],
    ...overrides,
  };
}

function renderWithDetail(overrides: Record<string, unknown> = {}) {
  mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
    selector({ user: { id: 'viewer-1', role: 'supervisor' } }),
  );
  mockUseInventoryApprovalDetail.mockReturnValue({ data: detail(overrides) });
  mockUseApprove.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseReturn.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseCorrect.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseCancel.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  return render(<InventoryApprovalDetailDialog id="req-1" onOpenChange={vi.fn()} branchId={BRANCH_ID} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InventoryApprovalDetailDialog — Responsible Staff / Identity Status (POS-PERF-P30R4)', () => {
  it('shows the account submitter and a distinct PIN-verified responsible staff member with the verification timestamp', () => {
    renderWithDetail({
      submitted_by_name: 'Branch Account',
      responsible_staff_name: 'Juan Dela Cruz',
      pin_verified_at: '2026-08-03T02:00:00.000Z',
    });

    expect(screen.getByText('Branch Account')).toBeInTheDocument();
    expect(screen.getByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(screen.getByText('PIN Verified')).toBeInTheDocument();
  });

  it('shows the same person for submitter and responsible staff on a supervisor direct record', () => {
    renderWithDetail({
      submitted_by_name: 'Maria Santos',
      responsible_staff_name: 'Maria Santos',
      pin_verified_at: '2026-08-03T02:00:00.000Z',
    });

    expect(screen.getAllByText('Maria Santos')).toHaveLength(2);
    expect(screen.getByText('PIN Verified')).toBeInTheDocument();
  });

  it('shows Not recorded with a dash status when there is no responsible staff identity', () => {
    renderWithDetail({ responsible_staff_name: null, pin_verified_at: null });

    expect(screen.getByText('Not recorded')).toBeInTheDocument();
    expect(screen.queryByText('PIN Verified')).not.toBeInTheDocument();
    expect(screen.queryByText('Not PIN verified')).not.toBeInTheDocument();
  });

  it('labels a present staff name as Not PIN verified when the verification timestamp is absent', () => {
    renderWithDetail({ responsible_staff_name: 'Pedro Reyes', pin_verified_at: null });

    expect(screen.getByText('Pedro Reyes')).toBeInTheDocument();
    expect(screen.getByText('Not PIN verified')).toBeInTheDocument();
    expect(screen.queryByText('PIN Verified')).not.toBeInTheDocument();
  });

  it('renders a long responsible staff name without truncation', () => {
    renderWithDetail({
      responsible_staff_name: 'Maria Concepcion Dela Cruz-Santos Bautista',
      pin_verified_at: '2026-08-03T02:00:00.000Z',
    });

    expect(screen.getByText('Maria Concepcion Dela Cruz-Santos Bautista')).toBeInTheDocument();
  });
});
