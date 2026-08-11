import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { TransactionResponse } from '@potato-corner/shared';
import ReceiptsPage from './page';

const { mockUseAuth, mockUseTransactions, mockUseTransaction, mockUseAttendanceByEmployee, mockUseBranch, mockUseEmployee } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseTransactions: vi.fn(),
  mockUseTransaction: vi.fn(),
  mockUseAttendanceByEmployee: vi.fn(),
  mockUseBranch: vi.fn(),
  mockUseEmployee: vi.fn(),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransactions: mockUseTransactions,
  useTransaction: mockUseTransaction,
  useTransactionsRealtimeSync: vi.fn(),
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

// Irrelevant to this test — mocked so it never needs its own hook chain to mount inertly.
vi.mock('@/components/shared/transactions/view-payment-proof-dialog', () => ({
  ViewPaymentProofDialog: () => null,
}));

// Stand-ins that surface which transaction id each dialog opened with, so row
// click vs. Manage Transaction click can be told apart without exercising
// ReceiptModal's print/mark-printed logic or ViewTransactionDetailDialog's
// own void/permission logic (out of scope here).
vi.mock('@/components/pos/receipt-modal', () => ({
  ReceiptModal: ({ transaction }: { transaction: TransactionResponse | null }) =>
    transaction ? <div data-testid="receipt-modal">Receipt for {transaction.id}</div> : null,
}));

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

const STAFF_USER = { branchIds: ['branch-1'] };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(transactions: TransactionResponse[]) {
  mockUseAuth.mockReturnValue({ user: STAFF_USER });
  mockUseTransactions.mockReturnValue({ data: { transactions, total: transactions.length }, isLoading: false, isError: false, refetch: vi.fn() });
  mockUseTransaction.mockImplementation((id: string | null) => ({ data: transactions.find((t) => t.id === id) }));
  mockUseAttendanceByEmployee.mockReturnValue({ data: { records: [] } });
  mockUseBranch.mockReturnValue({ data: { name: 'Main Branch' } });
  mockUseEmployee.mockReturnValue({ data: { first_name: 'Jane', last_name: 'Doe' } });
}

/** Convention shared with the terminal page test suite: a throwing helper instead of `!` under noUncheckedIndexedAccess. */
function nthOf<T>(arr: readonly T[], index: number): T {
  const item = arr[index];
  if (item === undefined) throw new Error(`expected an element at index ${index}`);
  return item;
}

describe('ReceiptsPage — Manage Transaction (ViewTransactionDetailDialog)', () => {
  it('opens ReceiptModal for the clicked receipt row, not the detail dialog', () => {
    setup([transaction()]);
    render(<ReceiptsPage />);

    fireEvent.click(screen.getByText('PC-BR1-20260801-0001'));

    expect(screen.getByTestId('receipt-modal')).toHaveTextContent('Receipt for txn-1');
    expect(screen.queryByTestId('transaction-detail-dialog')).not.toBeInTheDocument();
  });

  it('shows a Manage Transaction button for each receipt row', () => {
    setup([transaction()]);
    render(<ReceiptsPage />);

    expect(screen.getByRole('button', { name: 'Manage Transaction' })).toBeInTheDocument();
  });

  it('opens ViewTransactionDetailDialog with the clicked row\'s transaction id, without opening ReceiptModal', () => {
    setup([transaction({ id: 'txn-1' })]);
    render(<ReceiptsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage Transaction' }));

    expect(screen.getByTestId('transaction-detail-dialog')).toHaveTextContent('Detail for txn-1');
    expect(screen.queryByTestId('receipt-modal')).not.toBeInTheDocument();
  });

  it('passes the correct transaction id to the detail dialog when multiple rows are present', () => {
    setup([transaction({ id: 'txn-1', receipt_number: 'PC-BR1-20260801-0001' }), transaction({ id: 'txn-2', receipt_number: 'PC-BR1-20260801-0002' })]);
    render(<ReceiptsPage />);

    fireEvent.click(nthOf(screen.getAllByRole('button', { name: 'Manage Transaction' }), 1));

    expect(screen.getByTestId('transaction-detail-dialog')).toHaveTextContent('Detail for txn-2');
  });

  it('leaves the receipt viewing/printing path unchanged — row click still opens ReceiptModal after a Manage Transaction click elsewhere', () => {
    setup([transaction({ id: 'txn-1', receipt_number: 'PC-BR1-20260801-0001' }), transaction({ id: 'txn-2', receipt_number: 'PC-BR1-20260801-0002' })]);
    render(<ReceiptsPage />);

    fireEvent.click(nthOf(screen.getAllByRole('button', { name: 'Manage Transaction' }), 0));
    expect(screen.getByTestId('transaction-detail-dialog')).toHaveTextContent('Detail for txn-1');

    fireEvent.click(screen.getByText('PC-BR1-20260801-0002'));
    expect(screen.getByTestId('receipt-modal')).toHaveTextContent('Receipt for txn-2');
  });
});

describe('ReceiptsPage — staff role skips the coworker attendance cross-reference', () => {
  it('does not query attendance-by-employee for a staff viewer (self-scoped server-side, would 403 on a coworker\'s receipt)', () => {
    mockUseAuth.mockReturnValue({ user: { branchIds: ['branch-1'], role: 'staff' } });
    mockUseTransactions.mockReturnValue({ data: { transactions: [transaction()], total: 1 }, isLoading: false, isError: false, refetch: vi.fn() });
    mockUseTransaction.mockImplementation((id: string | null) => ({ data: [transaction()].find((t) => t.id === id) }));
    mockUseAttendanceByEmployee.mockReturnValue({ data: { records: [] } });
    mockUseBranch.mockReturnValue({ data: { name: 'Main Branch' } });
    mockUseEmployee.mockReturnValue({ data: { first_name: 'Jane', last_name: 'Doe' } });

    render(<ReceiptsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage Transaction' }));

    expect(mockUseAttendanceByEmployee).toHaveBeenLastCalledWith(undefined, expect.anything());
  });

  it('still queries attendance-by-employee for a non-staff (branch) viewer', () => {
    setup([transaction()]);
    render(<ReceiptsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage Transaction' }));

    expect(mockUseAttendanceByEmployee).toHaveBeenLastCalledWith('employee-1', expect.anything());
  });
});
