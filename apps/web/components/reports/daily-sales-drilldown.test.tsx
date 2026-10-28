import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, within, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

const mockUseTransaction = vi.fn();
const mockUseTransactions = vi.fn();
const mockUseDiscountAuditTrail = vi.fn();

vi.mock('@/hooks/queries/use-transactions', () => ({
  useTransaction: (...args: unknown[]) => mockUseTransaction(...args),
  useTransactions: (...args: unknown[]) => mockUseTransactions(...args),
  useDiscountAuditTrail: (...args: unknown[]) => mockUseDiscountAuditTrail(...args),
  useMarkReceiptPrinted: () => ({ mutateAsync: vi.fn() }),
  usePaymentProof: () => ({ data: undefined, isLoading: false, isError: false }),
  useDiscountProof: () => ({ data: undefined, isLoading: false, isError: false }),
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
  has_discount_proof: false,
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

  // POS-PERF-P40 — the search runs on the server (debounced) so it covers
  // every page, and returns to page 1.
  it('sends the receipt number search to the server and resets to the first page', async () => {
    vi.useFakeTimers();
    try {
      render(
        <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
      );
      fireEvent.change(screen.getByLabelText('Receipt Number'), { target: { value: '000002' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      expect(mockUseTransactions).toHaveBeenLastCalledWith(expect.objectContaining({ receipt_search: '000002', page: 1 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('paginates on the server using the total, not the rows already loaded', () => {
    mockUseTransactions.mockReturnValue({
      data: { transactions: [CASH_TXN, GCASH_TXN], total: 140, page: 1, limit: 25 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    expect(mockUseTransactions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, limit: 25 }));
    expect(screen.getByText('140 transactions match the filters below.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download PDF \(140 matching\)/ })).toBeInTheDocument();
  });

  it('offers a per-transaction PDF download labelled with its receipt number', () => {
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Download PDF of PC-GMA-001-20260731-000002' })).toBeInTheDocument();
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

  // P3B P0-1 — Payment Proof and Discount Proof are separate evidence and
  // must be surfaced independently, not merged.
  it('shows Discount Proof but not Payment Proof for a cash transaction with a PWD discount proof', () => {
    mockUseTransactions.mockReturnValue({
      data: {
        transactions: [{ ...CASH_TXN, id: 'txn-cash-pwd', discount_type: 'pwd', discount_amount: 20, has_payment_proof: false, has_discount_proof: true }],
        total: 1,
        page: 1,
        limit: 100,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    const row = screen.getByText('PC-GMA-001-20260731-000001').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole('button', { name: 'View Proof' })).toBeInTheDocument();
    expect(within(row as HTMLElement).getAllByRole('button', { name: 'View Proof' })).toHaveLength(1);
  });

  it('shows Payment Proof but not Discount Proof for a GCash transaction with no discount', () => {
    mockUseTransactions.mockReturnValue({
      data: { transactions: [GCASH_TXN], total: 1, page: 1, limit: 100 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    const row = screen.getByText('PC-GMA-001-20260731-000002').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getAllByRole('button', { name: 'View Proof' })).toHaveLength(1);
  });

  it('shows both Payment Proof and Discount Proof independently for a GCash transaction with a PWD discount', () => {
    mockUseTransactions.mockReturnValue({
      data: {
        transactions: [{ ...GCASH_TXN, id: 'txn-gcash-pwd', discount_type: 'pwd', discount_amount: 20, has_payment_proof: true, has_discount_proof: true }],
        total: 1,
        page: 1,
        limit: 100,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />,
    );
    const row = screen.getByText('PC-GMA-001-20260731-000002').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getAllByRole('button', { name: 'View Proof' })).toHaveLength(2);
  });
});

// POS-PERF-P41R4 — closing a proof viewer must hand focus back to the exact
// View Proof that opened it. It used to fall to <body>: the dialogs have no
// Radix Trigger to return to, and every cell remounted when the dialog opened.
describe('DailySalesDrilldown proof viewer focus', () => {
  const PROOF_A = { ...GCASH_TXN, id: 'txn-a', receipt_number: 'PC-GMA-001-20260731-00000A', discount_type: 'pwd', discount_amount: 20, has_discount_proof: true };
  const PROOF_B = { ...PROOF_A, id: 'txn-b', receipt_number: 'PC-GMA-001-20260731-00000B' };

  function listing(transactions: unknown[]) {
    return { data: { transactions, total: transactions.length, page: 1, limit: 25 }, isLoading: false, isError: false, refetch: vi.fn() };
  }

  // While a proof viewer is open the sheet is aria-hidden, so role queries need `hidden`.
  function proofButtons(receipt: string) {
    const row = screen.getByText(receipt).closest('tr');
    if (!row) throw new Error(`no row for ${receipt}`);
    const [payment, discount] = within(row).getAllByRole('button', { name: 'View Proof', hidden: true });
    if (!payment || !discount) throw new Error(`expected two View Proof buttons for ${receipt}`);
    return { payment, discount };
  }

  async function openFrom(button: HTMLElement, name: 'Payment Proof' | 'Discount Proof') {
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    return dialog;
  }

  async function closeWith(dialog: HTMLElement, how: 'button' | 'escape') {
    if (how === 'button') fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    else fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  }

  const renderSheet = (onOpenChange = vi.fn()) =>
    render(<DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={onOpenChange} />);

  beforeEach(() => {
    mockUseTransactions.mockReturnValue(listing([PROOF_A, PROOF_B]));
  });

  it('returns focus to the payment View Proof of the row that opened it, on Close and on Escape', async () => {
    const onOpenChange = vi.fn();
    renderSheet(onOpenChange);

    const trigger = proofButtons(PROOF_B.receipt_number).payment;
    await closeWith(await openFrom(trigger, 'Payment Proof'), 'button');
    await waitFor(() => expect(proofButtons(PROOF_B.receipt_number).payment).toHaveFocus());
    expect(proofButtons(PROOF_B.receipt_number).payment).toBe(trigger);

    await closeWith(await openFrom(trigger, 'Payment Proof'), 'escape');
    await waitFor(() => expect(trigger).toHaveFocus());
    // Escape closed only the viewer, not the transactions panel behind it.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /Transactions — Puregold GMA/ })).toBeInTheDocument();
  });

  it('returns focus to the discount View Proof, not the first View Proof in the table', async () => {
    renderSheet();
    const trigger = proofButtons(PROOF_B.receipt_number).discount;
    await closeWith(await openFrom(trigger, 'Discount Proof'), 'button');
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(proofButtons(PROOF_A.receipt_number).payment).not.toHaveFocus();
  });

  it('keeps the same trigger through a background refetch while the viewer is open', async () => {
    const { rerender } = renderSheet();
    const trigger = proofButtons(PROOF_A.receipt_number).payment;
    const dialog = await openFrom(trigger, 'Payment Proof');

    // A refetch hands back new objects for the same transactions.
    mockUseTransactions.mockReturnValue(listing([{ ...PROOF_A }, { ...PROOF_B }]));
    rerender(<DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />);
    expect(proofButtons(PROOF_A.receipt_number).payment).toBe(trigger);

    await closeWith(dialog, 'escape');
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('falls back to the Receipt Number search when the originating row is gone', async () => {
    const { rerender } = renderSheet();
    const dialog = await openFrom(proofButtons(PROOF_B.receipt_number).payment, 'Payment Proof');

    mockUseTransactions.mockReturnValue(listing([PROOF_A]));
    rerender(<DailySalesDrilldown open branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" onOpenChange={vi.fn()} />);
    expect(screen.queryByText(PROOF_B.receipt_number)).not.toBeInTheDocument();

    await closeWith(dialog, 'button');
    await waitFor(() => expect(screen.getByLabelText('Receipt Number')).toHaveFocus());
  });

  it('returns focus to the control that opened the transactions panel when the panel closes', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            View Transactions
          </button>
          <DailySalesDrilldown open={open} onOpenChange={setOpen} branchId="branch-1" branchName="Puregold GMA" reportDate="2026-07-30" />
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'View Transactions' });
    opener.focus();
    fireEvent.click(opener);
    const sheet = await screen.findByRole('dialog', { name: /Transactions — Puregold GMA/ });

    // A proof viewer opened and closed inside the panel doesn't disturb that.
    await closeWith(await openFrom(proofButtons(PROOF_A.receipt_number).payment, 'Payment Proof'), 'escape');
    await waitFor(() => expect(proofButtons(PROOF_A.receipt_number).payment).toHaveFocus());

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(sheet).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
