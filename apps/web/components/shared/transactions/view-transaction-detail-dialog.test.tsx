import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { TransactionResponse } from '@potato-corner/shared';
import { ViewTransactionDetailDialog } from './view-transaction-detail-dialog';

const { mockUseAuthStore, mockUseVoidTransaction, mockUseRefundTransaction, mockVoidMutate, mockRefundMutate } = vi.hoisted(() => ({
  mockUseAuthStore: vi.fn(),
  mockUseVoidTransaction: vi.fn(),
  mockUseRefundTransaction: vi.fn(),
  mockVoidMutate: vi.fn(),
  mockRefundMutate: vi.fn(),
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: mockUseAuthStore,
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useVoidTransaction: mockUseVoidTransaction,
  useRefundTransaction: mockUseRefundTransaction,
}));

function transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
  return {
    id: 'txn-1',
    receipt_number: 'PC-BR1-20260801-0001',
    branch_id: 'branch-1',
    shift_id: null,
    cashier_id: 'employee-1',
    status: 'completed',
    payment_method: 'cash',
    subtotal: 150,
    discount_amount: 0,
    discount_type: null,
    vat_amount: 16.07,
    vat_exempt_amount: 0,
    total_amount: 150,
    cash_tendered: 150,
    change_given: 0,
    gcash_reference_number: null,
    gcash_manually_verified: null,
    payment_reference: null,
    has_payment_proof: false,
    payment_proof_type: null,
    payment_proof_uploaded_at: null,
    receipt_printed: false,
    inventory_deduction_status: 'completed',
    is_offline_transaction: false,
    offline_provisional_number: null,
    synced_at: null,
    voided_at: null,
    voided_by_id: null,
    void_reason: null,
    refunded_at: null,
    refunded_by_id: null,
    refund_reason: null,
    created_at: '2026-08-01T08:00:00.000Z',
    updated_at: '2026-08-01T08:00:00.000Z',
    items: [],
    ...overrides,
  } as TransactionResponse;
}

function setRole(role: string | undefined) {
  mockUseAuthStore.mockImplementation((selector: (state: { user: { role: string } | null }) => unknown) =>
    selector({ user: role ? { role } : null }),
  );
}

function setup({
  role = 'branch',
  voidOverrides = {},
  refundOverrides = {},
}: {
  role?: string | undefined;
  voidOverrides?: Partial<{ mutate: typeof mockVoidMutate; isPending: boolean }>;
  refundOverrides?: Partial<{ mutate: typeof mockRefundMutate; isPending: boolean }>;
} = {}) {
  setRole(role);
  mockUseVoidTransaction.mockReturnValue({ mutate: mockVoidMutate, isPending: false, ...voidOverrides });
  mockUseRefundTransaction.mockReturnValue({ mutate: mockRefundMutate, isPending: false, ...refundOverrides });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const NOOP = () => {};

describe('ViewTransactionDetailDialog — Refund Transaction', () => {
  it('shows Refund for authorized roles on a completed transaction', () => {
    setup({ role: 'branch' });
    render(
      <ViewTransactionDetailDialog transaction={transaction()} onClose={NOOP} branchName="Main" cashierName="Jane Doe" attendanceRecords={[]} />,
    );

    expect(screen.getByRole('button', { name: 'Refund Transaction' })).toBeInTheDocument();
  });

  it('does not show Refund for STAFF', () => {
    setup({ role: 'staff' });
    render(
      <ViewTransactionDetailDialog transaction={transaction()} onClose={NOOP} branchName="Main" cashierName="Jane Doe" attendanceRecords={[]} />,
    );

    expect(screen.queryByRole('button', { name: 'Refund Transaction' })).not.toBeInTheDocument();
  });

  it('does not show Refund on a voided transaction', () => {
    setup({ role: 'branch' });
    render(
      <ViewTransactionDetailDialog
        transaction={transaction({ status: 'voided', voided_at: '2026-08-01T09:00:00.000Z' })}
        onClose={NOOP}
        branchName="Main"
        cashierName="Jane Doe"
        attendanceRecords={[]}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Refund Transaction' })).not.toBeInTheDocument();
  });

  it('does not show Refund on an already-refunded transaction', () => {
    setup({ role: 'branch' });
    render(
      <ViewTransactionDetailDialog
        transaction={transaction({ status: 'refunded', refunded_at: '2026-08-01T09:00:00.000Z' })}
        onClose={NOOP}
        branchName="Main"
        cashierName="Jane Doe"
        attendanceRecords={[]}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Refund Transaction' })).not.toBeInTheDocument();
  });

  it('shows transaction details and a full-refund warning in the refund dialog', () => {
    setup({ role: 'branch' });
    render(
      <ViewTransactionDetailDialog transaction={transaction()} onClose={NOOP} branchName="Main" cashierName="Jane Doe" attendanceRecords={[]} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refund Transaction' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Refund Transaction' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('PC-BR1-20260801-0001')).toBeInTheDocument();
    expect(within(dialog).getByText('Jane Doe')).toBeInTheDocument();
    expect(within(dialog).getByText(/restores the inventory deducted by this sale/)).toBeInTheDocument();
  });

  it('blocks confirmation when the reason is shorter than 10 characters', () => {
    setup({ role: 'branch' });
    render(
      <ViewTransactionDetailDialog transaction={transaction()} onClose={NOOP} branchName="Main" cashierName="Jane Doe" attendanceRecords={[]} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refund Transaction' }));
    fireEvent.change(screen.getByLabelText('Refund Reason'), { target: { value: 'too short' } });

    expect(screen.getByRole('button', { name: 'Confirm Refund' })).toBeDisabled();
  });

  it('calls useRefundTransaction with the trimmed reason once valid', () => {
    setup({ role: 'branch' });
    render(
      <ViewTransactionDetailDialog transaction={transaction()} onClose={NOOP} branchName="Main" cashierName="Jane Doe" attendanceRecords={[]} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refund Transaction' }));
    fireEvent.change(screen.getByLabelText('Refund Reason'), { target: { value: '  Customer requested a refund  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Refund' }));

    expect(mockRefundMutate).toHaveBeenCalledWith(
      { refund_reason: 'Customer requested a refund' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('disables controls while the refund mutation is pending', () => {
    setup({ role: 'branch', refundOverrides: { isPending: true } });
    render(
      <ViewTransactionDetailDialog transaction={transaction()} onClose={NOOP} branchName="Main" cashierName="Jane Doe" attendanceRecords={[]} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refund Transaction' }));

    expect(screen.getByLabelText('Refund Reason')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('closes the dialog and clears the reason on success', () => {
    setup({ role: 'branch' });
    mockRefundMutate.mockImplementation((_input, { onSuccess }: { onSuccess: () => void }) => onSuccess());

    render(
      <ViewTransactionDetailDialog transaction={transaction()} onClose={NOOP} branchName="Main" cashierName="Jane Doe" attendanceRecords={[]} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refund Transaction' }));
    fireEvent.change(screen.getByLabelText('Refund Reason'), { target: { value: 'Customer requested a refund' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Refund' }));

    expect(screen.queryByRole('alertdialog', { name: 'Refund Transaction' })).not.toBeInTheDocument();
  });

  it('shows Refunded status once the transaction reflects the refund', () => {
    setup({ role: 'branch' });
    const { rerender } = render(
      <ViewTransactionDetailDialog transaction={transaction()} onClose={NOOP} branchName="Main" cashierName="Jane Doe" attendanceRecords={[]} />,
    );

    rerender(
      <ViewTransactionDetailDialog
        transaction={transaction({ status: 'refunded', refunded_at: '2026-08-01T09:00:00.000Z' })}
        onClose={NOOP}
        branchName="Main"
        cashierName="Jane Doe"
        attendanceRecords={[]}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Refund Transaction' })).not.toBeInTheDocument();
  });
});

describe('ViewTransactionDetailDialog — Void Transaction (unchanged)', () => {
  it('still shows Void for authorized roles and calls useVoidTransaction unchanged', () => {
    setup({ role: 'branch' });
    render(
      <ViewTransactionDetailDialog transaction={transaction()} onClose={NOOP} branchName="Main" cashierName="Jane Doe" attendanceRecords={[]} />,
    );

    expect(screen.getByRole('button', { name: 'Void Transaction' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Void Transaction' }));
    fireEvent.change(screen.getByLabelText(/Reason \(required/), { target: { value: 'Wrong item entered' } });
    const voidDialog = screen.getByRole('alertdialog', { name: 'Void Transaction' });
    fireEvent.click(within(voidDialog).getByRole('button', { name: 'Void Transaction' }));

    expect(mockVoidMutate).toHaveBeenCalledWith({ void_reason: 'Wrong item entered' }, expect.objectContaining({ onSuccess: expect.any(Function) }));
  });
});
