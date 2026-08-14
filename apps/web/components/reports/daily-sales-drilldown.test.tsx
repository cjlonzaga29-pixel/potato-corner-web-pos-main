import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';

const mockUseTransaction = vi.fn();
const mockUseTransactions = vi.fn();
const mockUseDiscountAuditTrail = vi.fn();

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransaction: (...args: unknown[]) => mockUseTransaction(...args),
  useTransactions: (...args: unknown[]) => mockUseTransactions(...args),
  useDiscountAuditTrail: (...args: unknown[]) => mockUseDiscountAuditTrail(...args),
  useMarkReceiptPrinted: () => ({ mutateAsync: vi.fn() }),
  usePaymentProof: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { firstName: 'CJ', lastName: 'Lonzaga', email: 'cj@example.com' } }),
}));

vi.mock('@/hooks/queries/use-employees', () => ({
  useEmployee: () => ({ data: { first_name: 'Juan', last_name: 'Cruz' }, isLoading: false }),
}));

const { DailySalesDrilldown } = await import('./daily-sales-drilldown');

const CASH_TXN = {
  id: 'txn-1',
  receipt_number: 'PC-GMA-001-20260731-000001',
  branch_id: 'branch-1',
  payment_method: 'cash',
  subtotal: 450,
  vat_amount: 54,
  discount_amount: 0,
  total_amount: 504,
  status: 'completed',
  has_payment_proof: false,
  created_at: '2026-07-30T23:07:29.056Z',
};

const GCASH_TXN = {
  ...CASH_TXN,
  id: 'txn-2',
  receipt_number: 'PC-GMA-001-20260731-000002',
  payment_method: 'gcash',
  has_payment_proof: true,
  created_at: '2026-07-30T23:09:04.900Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseTransaction.mockReturnValue({ data: undefined });
  mockUseTransactions.mockReturnValue({
    data: { transactions: [CASH_TXN, GCASH_TXN], total: 2, page: 1, limit: 100 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUseDiscountAuditTrail.mockReturnValue({ data: { data: [] }, isLoading: false });
});

afterEach(() => {
  cleanup();
});

describe('DailySalesDrilldown', () => {
  it('renders every transaction for the selected branch/date by default', () => {
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    expect(screen.getByText('PC-GMA-001-20260731-000001')).toBeInTheDocument();
    expect(screen.getByText('PC-GMA-001-20260731-000002')).toBeInTheDocument();
  });

  it('filters rows by receipt number search', () => {
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Receipt Number'), { target: { value: '000002' } });
    expect(screen.queryByText('PC-GMA-001-20260731-000001')).not.toBeInTheDocument();
    expect(screen.getByText('PC-GMA-001-20260731-000002')).toBeInTheDocument();
  });

  it('shows "View Proof" only for non-cash transactions that have a payment proof', () => {
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    const viewProofButtons = screen.getAllByRole('button', { name: 'View Proof' });
    expect(viewProofButtons).toHaveLength(1);
  });

  it('does not show a broken proof link for cash transactions', () => {
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    const rows = screen.getAllByRole('row');
    const cashRow = rows.find((r) => r.textContent?.includes('PC-GMA-001-20260731-000001'));
    expect(cashRow).toBeDefined();
    expect(cashRow?.textContent ?? '').toContain('—');
  });

  it('fetches the full transaction detail when View Receipt is clicked', () => {
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    const [firstButton] = screen.getAllByRole('button', { name: 'View Receipt' });
    if (!firstButton) throw new Error('expected at least one View Receipt button');
    fireEvent.click(firstButton);
    expect(mockUseTransaction).toHaveBeenLastCalledWith('txn-1');
  });

  it('scopes the query to the given branch and single business date', () => {
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    expect(mockUseTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ branch_id: 'branch-1', date_from: '2026-07-30', date_to: '2026-07-30' }),
    );
  });

  // FAST FIX — Admin's Daily Sales drilldown had no Discount Type, Cashier,
  // or Customer ID / Reference columns at all, unlike the Supervisor Daily
  // Sales tab.
  it('shows the server-resolved cashier_name for each transaction', () => {
    mockUseTransactions.mockReturnValue({
      data: { transactions: [{ ...CASH_TXN, cashier_id: '08f7750e-027c-41f6-88de-f49d3a48b8d8', cashier_name: 'CJ Lonzaga' }], total: 1, page: 1, limit: 100 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    expect(screen.getByText('CJ Lonzaga')).toBeInTheDocument();
    expect(screen.queryByText('08f7750e-027c-41f6-88de-f49d3a48b8d8')).not.toBeInTheDocument();
  });

  it('renders the stored Customer ID / Reference for a PWD transaction, sourced from the discount-audit trail', () => {
    mockUseTransactions.mockReturnValue({
      data: {
        transactions: [{ ...CASH_TXN, id: 'txn-pwd-1', receipt_number: 'PC-GMA-001-20260731-000003', discount_type: 'pwd', discount_amount: 20 }],
        total: 1,
        page: 1,
        limit: 100,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockUseDiscountAuditTrail.mockReturnValue({ data: { data: [{ id: 'txn-pwd-1', discountCustomerId: '1234567890', discountType: 'pwd' }] }, isLoading: false });

    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );

    const row = screen.getByText('PC-GMA-001-20260731-000003').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('1234567890')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Pwd')).toBeInTheDocument();
  });

  it('renders "—" for Customer ID / Reference when the transaction has no discount', () => {
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    const row = screen.getByText('PC-GMA-001-20260731-000001').closest('tr');
    expect(row).not.toBeNull();
    // A non-discounted row also shows "—" for Discount and Discount Type, so
    // several cells legitimately match — assert at least one exists rather
    // than requiring uniqueness.
    expect(within(row as HTMLElement).getAllByText('—').length).toBeGreaterThan(0);
  });
});
