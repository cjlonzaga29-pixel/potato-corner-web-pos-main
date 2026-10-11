import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { InventoryApprovalDetailDialog } from './inventory-approval-detail-dialog';

const {
  mockUseAuthStore,
  mockUseInventoryApprovalDetail,
  mockUseApprove,
  mockUseReturn,
  mockUseCorrect,
  mockUseCancel,
  mockUseInventoryItemConversions,
} = vi.hoisted(() => ({
  mockUseAuthStore: vi.fn(),
  mockUseInventoryApprovalDetail: vi.fn(),
  mockUseApprove: vi.fn(),
  mockUseReturn: vi.fn(),
  mockUseCorrect: vi.fn(),
  mockUseCancel: vi.fn(),
  mockUseInventoryItemConversions: vi.fn(),
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

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryItemConversions: mockUseInventoryItemConversions,
  useUploadInventoryEvidence: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/queries/use-staff-pin', () => ({
  useVerifyStaffPin: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false }),
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

function renderWithDetail(overrides: Record<string, unknown> = {}, mutationOverrides: Record<string, unknown> = {}) {
  mockUseAuthStore.mockImplementation((selector: (s: { user: { id: string; role: string } }) => unknown) =>
    selector({ user: { id: 'viewer-1', role: 'supervisor' } }),
  );
  mockUseInventoryApprovalDetail.mockReturnValue({ data: detail(overrides) });
  mockUseApprove.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseReturn.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseCorrect.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false, ...mutationOverrides });
  mockUseCancel.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseInventoryItemConversions.mockReturnValue({ data: [] });
  return render(<InventoryApprovalDetailDialog id="req-1" onOpenChange={vi.fn()} branchId={BRANCH_ID} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InventoryApprovalDetailDialog — Recorded By / Identity Status', () => {
  it('never renders the account submitter — only shows the PIN-identified Recorded By staff', () => {
    renderWithDetail({
      submitted_by_name: 'Branch Account',
      responsible_staff_name: 'Juan Dela Cruz',
      pin_verified_at: '2026-08-03T02:00:00.000Z',
    });

    expect(screen.queryByText('Branch Account')).not.toBeInTheDocument();
    expect(screen.queryByText('Submitted By (Account)')).not.toBeInTheDocument();
    expect(screen.getByText('Recorded By')).toBeInTheDocument();
    expect(screen.getByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(screen.getByText('PIN Verified')).toBeInTheDocument();
  });

  it('keeps Reviewed By separate from Recorded By for the approving supervisor', () => {
    renderWithDetail({
      responsible_staff_name: 'Juan Dela Cruz',
      pin_verified_at: '2026-08-03T02:00:00.000Z',
      status: 'APPROVED',
      reviewed_by_user_id: 'sup-1',
      reviewed_by_name: 'Supervisor Reyes',
      reviewed_at: '2026-08-03T03:00:00.000Z',
    });

    expect(screen.getByText('Reviewed By')).toBeInTheDocument();
    expect(screen.getByText('Supervisor Reyes')).toBeInTheDocument();
    expect(screen.getByText('Recorded By')).toBeInTheDocument();
    expect(screen.getByText('Juan Dela Cruz')).toBeInTheDocument();
  });

  it('shows the same person for Recorded By on a supervisor direct record without rendering it twice as submitter', () => {
    renderWithDetail({
      submitted_by_name: 'Maria Santos',
      responsible_staff_name: 'Maria Santos',
      pin_verified_at: '2026-08-03T02:00:00.000Z',
    });

    expect(screen.getAllByText('Maria Santos')).toHaveLength(1);
    expect(screen.getByText('PIN Verified')).toBeInTheDocument();
  });

  it('shows Not recorded with a dash status when there is no responsible staff identity — never falls back to the submitter', () => {
    renderWithDetail({ responsible_staff_name: null, pin_verified_at: null, submitted_by_name: 'Branch Account' });

    expect(screen.getByText('Not recorded')).toBeInTheDocument();
    expect(screen.queryByText('Branch Account')).not.toBeInTheDocument();
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

describe('InventoryApprovalDetailDialog — Correct & Resubmit (POS-PERF-P31)', () => {
  it('pre-fills the corrected quantity and notes from the current revision, and Resubmit is enabled with no changes at all', () => {
    renderWithDetail({
      status: 'RETURNED',
      operation: 'ADJUSTMENT',
      quantity_delta: -5,
      reason_code: 'count_correction',
      notes: 'original notes',
      return_reason: 'quantity looked off',
    });

    const quantityInput = screen.getByLabelText('Corrected Quantity Change') as HTMLInputElement;
    const notesInput = screen.getByLabelText('Notes') as HTMLInputElement;
    expect(quantityInput.value).toBe('-5');
    expect(notesInput.value).toBe('original notes');

    // The root cause this replaces: correctionQuantity used to start at ''
    // and gate Resubmit on Boolean(correctionQuantity) alone, so an
    // untouched (but now pre-filled) field left the button disabled forever.
    expect(screen.getByRole('button', { name: 'Resubmit for Review' })).not.toBeDisabled();
  });

  it('editing notes only on a Physical Count correction (never PIN-bound) keeps Resubmit enabled — reproduces and fixes the reported defect', () => {
    renderWithDetail({
      status: 'RETURNED',
      operation: 'PHYSICAL_COUNT',
      counted_quantity: 42,
      notes: 'old note',
    });

    fireEvent.change(screen.getByLabelText('Corrected Counted Quantity'), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'corrected note after recount' } });

    expect(screen.getByRole('button', { name: 'Resubmit for Review' })).not.toBeDisabled();
  });

  it('changing the quantity on a PIN-bound operation blocks Resubmit and lists exactly what is missing, instead of an unexplained disabled button', () => {
    renderWithDetail({
      status: 'RETURNED',
      target: 'UNIVERSAL_ITEM',
      operation: 'ADJUSTMENT',
      quantity_delta: -5,
      reason_code: 'count_correction',
      responsible_staff_name: 'Juan Dela Cruz',
      pin_verified_at: '2026-08-03T02:00:00.000Z',
    });

    fireEvent.change(screen.getByLabelText('Corrected Quantity Change'), { target: { value: '-8' } });

    expect(screen.getByRole('button', { name: 'Resubmit for Review' })).toBeDisabled();
    expect(screen.getByText('New Verification Required')).toBeInTheDocument();
    expect(screen.getByText(/Upload a new proof photo/)).toBeInTheDocument();
    expect(screen.getByText(/Verify a staff PIN again/)).toBeInTheDocument();
    // The original (pre-change) verification is still shown, distinctly labeled, not hidden.
    expect(screen.getByText(/Original Verification/)).toBeInTheDocument();
  });

  it('a correction with no PIN-bound changes can resubmit without any fresh verification UI at all', () => {
    renderWithDetail({
      status: 'RETURNED',
      target: 'UNIVERSAL_ITEM',
      operation: 'ADJUSTMENT',
      quantity_delta: -5,
      reason_code: 'count_correction',
      notes: null,
    });

    expect(screen.queryByText('New Verification Required')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resubmit for Review' })).not.toBeDisabled();
  });
});
