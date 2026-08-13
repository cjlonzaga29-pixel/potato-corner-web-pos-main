import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { TransactionResponse } from '@potato-corner/shared';
import { ReceiptModal } from './receipt-modal';

const { mockUseMarkReceiptPrinted, mockUseEmployee } = vi.hoisted(() => ({
  mockUseMarkReceiptPrinted: vi.fn(),
  mockUseEmployee: vi.fn(),
}));

vi.mock('@/hooks/queries/use-transactions', () => ({
  useMarkReceiptPrinted: mockUseMarkReceiptPrinted,
}));

vi.mock('@/hooks/queries/use-employees', () => ({
  useEmployee: mockUseEmployee,
}));

function transaction(overrides: Partial<TransactionResponse> = {}): TransactionResponse {
  return {
    id: 'txn-1',
    receipt_number: 'PC-BR1-20260806-0042',
    branch_id: 'branch-1',
    shift_id: 'shift-1',
    cashier_id: 'employee-1',
    status: 'completed',
    payment_method: 'cash',
    subtotal: 195,
    discount_amount: 20,
    discount_type: 'senior_citizen',
    discount_rate_used: 20,
    vat_amount: 18.75,
    vat_exempt_amount: 0,
    total_amount: 175,
    cash_tendered: 200,
    change_given: 25,
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
    created_at: '2026-08-06T07:41:00.000Z',
    updated_at: '2026-08-06T07:41:00.000Z',
    items: [
      {
        id: 'item-1',
        product_id: 'product-1',
        product_variant_id: 'variant-1',
        flavor_id: 'flavor-1',
        product_name: 'Classic Cheese',
        variant_name: 'Large',
        flavor_name: 'Regular',
        unit_price: 60,
        quantity: 2,
        line_total: 120,
        recipe_version: 1,
        selected_options: [{ option_id: 'opt-1', option_name: 'Extra Cheese', option_group_id: 'group-1', option_group_name: 'Add-ons', price_adjustment: 15 }],
      },
      {
        id: 'item-2',
        product_id: 'product-2',
        product_variant_id: 'variant-2',
        flavor_id: null,
        product_name: 'Sour Cream',
        variant_name: 'Medium',
        flavor_name: null,
        unit_price: 60,
        quantity: 1,
        line_total: 60,
        recipe_version: 1,
        selected_options: [],
      },
    ],
    ...overrides,
  } as TransactionResponse;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup() {
  const mutateAsync = vi.fn().mockResolvedValue(undefined);
  mockUseMarkReceiptPrinted.mockReturnValue({ mutateAsync, isPending: false });
  mockUseEmployee.mockReturnValue({ data: { first_name: 'Juan', last_name: 'Dela Cruz' } });
  return { mutateAsync };
}

describe('ReceiptModal', () => {
  it('renders every required receipt field for a multi-item sale with options, discount, VAT, and cash payment', () => {
    setup();
    render(<ReceiptModal transaction={transaction()} onClose={vi.fn()} />);

    // business identity, receipt number, cashier
    expect(screen.getAllByText('Potato Corner').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Receipt No\. PC-BR1-20260806-0042/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Cashier: Juan Dela Cruz/)).toBeInTheDocument();

    // both line items
    expect(screen.getByText(/2x Classic Cheese \(Regular\) — Large/)).toBeInTheDocument();
    expect(screen.getByText(/1x Sour Cream — Medium/)).toBeInTheDocument();

    // selected option / add-on
    expect(screen.getByText('+ Extra Cheese')).toBeInTheDocument();

    // totals block
    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.getByText('₱195.00')).toBeInTheDocument();
    // Task 209.xx — shows the human-readable type name + the rate frozen on
    // this transaction (discount_rate_used), never a raw "senior_citizen" string.
    expect(screen.getByText('Senior Citizen Discount (20%)')).toBeInTheDocument();
    expect(screen.getByText('-₱20.00')).toBeInTheDocument();
    expect(screen.getByText('VAT (12%)')).toBeInTheDocument();
    expect(screen.getByText('₱18.75')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getAllByText('₱175.00').length).toBeGreaterThan(0);

    // payment method (printable row, not just the screen-only header badge) + tendered/change
    expect(screen.getByText('Payment Method')).toBeInTheDocument();
    expect(screen.getAllByText('Cash').length).toBeGreaterThan(0);
    expect(screen.getByText('Cash Tendered')).toBeInTheDocument();
    expect(screen.getByText('₱200.00')).toBeInTheDocument();
    expect(screen.getByText('Change')).toBeInTheDocument();
    expect(screen.getByText('₱25.00')).toBeInTheDocument();
  });

  it('renders a GCash payment reference instead of tendered/change', () => {
    setup();
    render(<ReceiptModal transaction={transaction({ payment_method: 'gcash', payment_reference: 'GC-REF-001', cash_tendered: null, change_given: null })} onClose={vi.fn()} />);

    expect(screen.getByText('GCash Ref.')).toBeInTheDocument();
    expect(screen.getByText('GC-REF-001')).toBeInTheDocument();
    expect(screen.queryByText('Cash Tendered')).not.toBeInTheDocument();
  });

  it('scopes the printable DOM under #receipt-print-area, including the payment method', () => {
    setup();
    render(<ReceiptModal transaction={transaction()} onClose={vi.fn()} />);

    // Dialog content renders into a Radix portal appended to document.body,
    // outside RTL's own `container` wrapper.
    const printArea = document.querySelector('#receipt-print-area');
    expect(printArea).not.toBeNull();
    expect(printArea).toHaveTextContent('Potato Corner');
    expect(printArea).toHaveTextContent('Classic Cheese');
    expect(printArea).toHaveTextContent('Payment Method');
    expect(printArea).toHaveTextContent('Total');
  });

  it('Print Receipt calls window.print()', () => {
    setup();
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<ReceiptModal transaction={transaction()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Print Receipt/i }));

    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('switches to "Print Again" after the first print, and calls window.print() again without a second charge', () => {
    const { mutateAsync } = setup();
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<ReceiptModal transaction={transaction()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Print Receipt/i }));
    expect(screen.getByRole('button', { name: /Print Again/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Print Again/i }));

    expect(printSpy).toHaveBeenCalledTimes(2);
    // Only the receipt-printed marker is re-sent, never another transaction/charge.
    expect(mutateAsync).toHaveBeenCalledTimes(2);
  });

  it('keeps the receipt mounted with its full content after printing (no premature clear)', () => {
    setup();
    vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<ReceiptModal transaction={transaction()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Print Receipt/i }));

    expect(screen.getAllByText(/Receipt No\. PC-BR1-20260806-0042/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('₱175.00').length).toBeGreaterThan(0);
  });

  it('only calls onClose (New Sale) on an explicit click, never as a side effect of printing', () => {
    setup();
    vi.spyOn(window, 'print').mockImplementation(() => {});
    const onClose = vi.fn();
    render(<ReceiptModal transaction={transaction()} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /Print Receipt/i }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'New Sale' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders entirely from the transaction prop — no cart store is imported or read', () => {
    // If ReceiptModal depended on live cart state, this render (no cart
    // store mocked/seeded anywhere in this file) would come up empty for
    // items; instead every line item from the transaction response renders.
    setup();
    render(<ReceiptModal transaction={transaction()} onClose={vi.fn()} />);

    expect(screen.getByText(/2x Classic Cheese/)).toBeInTheDocument();
    expect(screen.getByText(/1x Sour Cream/)).toBeInTheDocument();
  });

  it('renders nothing when there is no transaction', () => {
    setup();
    const { container } = render(<ReceiptModal transaction={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
