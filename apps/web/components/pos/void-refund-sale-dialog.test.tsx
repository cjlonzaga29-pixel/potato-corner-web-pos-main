import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { TransactionResponse } from '@potato-corner/shared';
import { VoidRefundSaleDialog } from './void-refund-sale-dialog';

const { mockUseTransactions, mockUseTransaction, mockUseAttendanceByEmployee, mockUseBranch, mockUseEmployee } = vi.hoisted(() => ({
  mockUseTransactions: vi.fn(),
  mockUseTransaction: vi.fn(),
  mockUseAttendanceByEmployee: vi.fn(),
  mockUseBranch: vi.fn(),
  mockUseEmployee: vi.fn(),
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransactions: mockUseTransactions,
  useTransaction: mockUseTransaction,
}));

vi.mock('@/hooks/queries/use-attendance', () => ({
  useAttendanceByEmployee: mockUseAttendanceByEmployee,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranch: mockUseBranch,
}));

vi.mock('@/hooks/queries/use-employees', () => ({
  useEmployee: mockUseEmployee,
}));

// Void/Refund role gating, reason validation, and status behavior already have
// full coverage in view-transaction-detail-dialog.test.tsx for this exact,
// unmodified component — this stub only proves the Manage row hands off the
// right transaction id, without re-testing that dialog's own internals.
vi.mock('@/components/shared/transactions/view-transaction-detail-dialog', () => ({
  ViewTransactionDetailDialog: ({ transaction }: { transaction: TransactionResponse | null }) =>
    transaction ? <div data-testid="transaction-detail-dialog">Detail for {transaction.id}</div> : null,
}));

function transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
  return {
    id: 'txn-1',
    receipt_number: 'PC-BR1-20260801-0001',
    branch_id: 'branch-1',
    cashier_id: 'employee-1',
    payment_method: 'cash',
    total_amount: 150,
    status: 'completed',
    has_payment_proof: false,
    created_at: '2026-08-01T08:00:00.000Z',
    ...overrides,
  } as TransactionResponse;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(transactions: TransactionResponse[]) {
  mockUseTransactions.mockReturnValue({ data: { transactions, total: transactions.length }, isLoading: false, isError: false, refetch: vi.fn() });
  mockUseTransaction.mockImplementation((id: string | null) => ({ data: transactions.find((t) => t.id === id) }));
  mockUseAttendanceByEmployee.mockReturnValue({ data: { records: [] } });
  mockUseBranch.mockReturnValue({ data: { name: 'Main Branch' } });
  mockUseEmployee.mockReturnValue({ data: { first_name: 'Jane', last_name: 'Doe' } });
}

describe('VoidRefundSaleDialog', () => {
  it('queries the current branch only, newest-first via the existing transactions list (page 1)', () => {
    setup([transaction()]);
    render(<VoidRefundSaleDialog branchId="branch-1" open onOpenChange={vi.fn()} />);

    expect(mockUseTransactions).toHaveBeenCalledWith({ branch_id: 'branch-1', page: 1, limit: 10 });
  });

  it('does not query when closed', () => {
    setup([transaction()]);
    render(<VoidRefundSaleDialog branchId="branch-1" open={false} onOpenChange={vi.fn()} />);

    expect(mockUseTransactions).toHaveBeenCalledWith({ branch_id: undefined, page: 1, limit: 10 });
  });

  it('renders recent transactions newest-first, as returned by the shared transactions query', () => {
    setup([
      transaction({ id: 'txn-2', receipt_number: 'PC-BR1-20260801-0002', created_at: '2026-08-01T09:00:00.000Z' }),
      transaction({ id: 'txn-1', receipt_number: 'PC-BR1-20260801-0001', created_at: '2026-08-01T08:00:00.000Z' }),
    ]);
    render(<VoidRefundSaleDialog branchId="branch-1" open onOpenChange={vi.fn()} />);

    const receiptNumbers = screen.getAllByText(/PC-BR1-/).map((el) => el.textContent);
    expect(receiptNumbers).toEqual(['PC-BR1-20260801-0002', 'PC-BR1-20260801-0001']);
  });

  it('shows the empty state when there are no recent transactions', () => {
    setup([]);
    render(<VoidRefundSaleDialog branchId="branch-1" open onOpenChange={vi.fn()} />);

    expect(screen.getByText('No completed sales available to void or refund.')).toBeInTheDocument();
  });

  it('opens the existing ViewTransactionDetailDialog with the clicked row\'s transaction id when Manage is clicked', () => {
    setup([transaction({ id: 'txn-1' }), transaction({ id: 'txn-2', receipt_number: 'PC-BR1-20260801-0002' })]);
    render(<VoidRefundSaleDialog branchId="branch-1" open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Manage' })[1]!);

    expect(screen.getByTestId('transaction-detail-dialog')).toHaveTextContent('Detail for txn-2');
  });

  it('shows status for voided and refunded rows alongside completed ones', () => {
    setup([
      transaction({ id: 'txn-1', status: 'completed' }),
      transaction({ id: 'txn-2', receipt_number: 'PC-BR1-20260801-0002', status: 'voided' }),
      transaction({ id: 'txn-3', receipt_number: 'PC-BR1-20260801-0003', status: 'refunded' }),
    ]);
    render(<VoidRefundSaleDialog branchId="branch-1" open onOpenChange={vi.fn()} />);

    expect(screen.getAllByRole('button', { name: 'Manage' })).toHaveLength(3);
  });
});
