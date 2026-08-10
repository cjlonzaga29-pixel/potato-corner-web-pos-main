import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CheckoutWorkspace } from './checkout-workspace';
import type { CartLine } from './cart-line-item';

afterEach(() => cleanup());

const CART_LINE: CartLine = {
  index: 0,
  item: { product_id: 'product-1', product_variant_id: 'variant-1', quantity: 1 },
  productName: 'Giga Fries',
  variantName: 'Large',
  flavorName: null,
  slotSelections: [],
  optionSelections: [],
  unitPrice: 200,
  quantity: 1,
  lineTotal: 200,
  vatableCapAmount: null,
  hasOptionGroups: false,
};

function baseProps() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    layout: 'two-pane' as const,
    cartLines: [CART_LINE],
    onEditLine: vi.fn(),
    onRemoveLine: vi.fn(),
    onQuantityChange: vi.fn(),
    subtotal: 200,
    vatAmount: 21.43,
    discountAmount: 0,
    totalAmount: 200,
    discountType: 'none' as const,
    onDiscountTypeChange: vi.fn(),
    discountIdReference: '',
    onDiscountIdReferenceChange: vi.fn(),
    discountProofKey: null,
    discountProofPreviewUrl: null,
    onDiscountProofSelected: vi.fn(),
    onClearDiscountProof: vi.fn(),
    promoAmount: '',
    onPromoAmountChange: vi.fn(),
    paymentMethod: 'cash' as const,
    onPaymentMethodChange: vi.fn(),
    isOnline: true,
    cashTendered: '200',
    onCashTenderedChange: vi.fn(),
    change: 0,
    paymentProofKey: null,
    paymentProofPreviewUrl: null,
    onProofSelected: vi.fn(),
    onClearProof: vi.fn(),
    chargeError: null,
    chargeDisabledReason: null,
    canCharge: true,
    isChargePending: false,
    onCharge: vi.fn(),
  };
}

// Radix Select is exercised elsewhere (payment-footer.test.tsx uses the real
// component); no need to mock it here since these tests never touch it.

describe('CheckoutWorkspace — two-pane layout (Task 209.25)', () => {
  it('renders Order Review and Payment side by side, both from the same passed-in cart/totals — no recalculation', () => {
    render(<CheckoutWorkspace {...baseProps()} />);

    expect(screen.getByRole('heading', { name: 'Order Review' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Payment' })).toBeInTheDocument();
    expect(screen.getByText('Giga Fries')).toBeInTheDocument();
    // Appears twice — once as the cart line total, once as the Order Review Total row.
    expect(screen.getAllByText('₱200.00').length).toBeGreaterThan(0);
    // Payment fields are visible in the same render — never a second "Continue" step on two-pane.
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue to Payment/ })).not.toBeInTheDocument();
  });

  it('shows the empty-cart state in Order Review without blocking the Payment pane', () => {
    render(<CheckoutWorkspace {...baseProps()} cartLines={[]} />);
    expect(screen.getByText('Cart is empty')).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  it('never invokes onCharge just by opening — only the Charge button does', () => {
    const props = baseProps();
    render(<CheckoutWorkspace {...props} />);
    expect(props.onCharge).not.toHaveBeenCalled();
  });

  it('blocks closing while a charge is pending (Escape/overlay), but allows it once settled', () => {
    const props = baseProps();
    const { rerender } = render(<CheckoutWorkspace {...props} isChargePending={true} />);
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    expect(props.onOpenChange).not.toHaveBeenCalled();

    rerender(<CheckoutWorkspace {...props} isChargePending={false} />);
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('CheckoutWorkspace — stepped layout (Task 209.25, mobile/tablet portrait)', () => {
  it('starts on Order Review with a Continue to Payment action, and never shows Payment fields yet', () => {
    render(<CheckoutWorkspace {...baseProps()} layout="stepped" />);

    expect(screen.getByText('Giga Fries')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to Payment' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('Continue to Payment moves to the Payment step, and Back returns to Order Review', () => {
    render(<CheckoutWorkspace {...baseProps()} layout="stepped" />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue to Payment' }));
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.queryByText('Giga Fries')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByText('Giga Fries')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('disables Continue to Payment for an empty cart', () => {
    render(<CheckoutWorkspace {...baseProps()} layout="stepped" cartLines={[]} />);
    expect(screen.getByRole('button', { name: 'Continue to Payment' })).toBeDisabled();
  });

  it('reopening resets back to the Order Review step, even after advancing to Payment last time', () => {
    const props = baseProps();
    const { rerender } = render(<CheckoutWorkspace {...props} layout="stepped" open={true} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue to Payment' }));
    expect(screen.getByRole('tablist')).toBeInTheDocument();

    rerender(<CheckoutWorkspace {...props} layout="stepped" open={false} />);
    rerender(<CheckoutWorkspace {...props} layout="stepped" open={true} />);

    expect(screen.getByRole('button', { name: 'Continue to Payment' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  // Task 209.29 — Part D's 3-step target flow: Payment fields render on
  // their own step (no proof cards, no Charge button mixed in), and a
  // separate, structurally distinct Proof & Confirm step holds the proof
  // cards + the real Charge control. `baseProps()` is cash/no-discount, so
  // no proof is ever required — the Payment step's own CTA becomes the real
  // Confirm control directly instead of an extra tap into an empty step.
  it('Payment step shows only fields (no proof cards, no Charge button); cash + no discount confirms directly from Payment, no separate Proof step', () => {
    render(<CheckoutWorkspace {...baseProps()} layout="stepped" />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Payment' }));

    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).toBeInTheDocument();
  });

  it('a proof-requiring payment method (GCash) gets its own Proof & Confirm step, reachable via Continue and back via Back', () => {
    render(<CheckoutWorkspace {...baseProps()} layout="stepped" paymentMethod="gcash" />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Payment' }));

    // Payment step: fields only, Charge not reachable yet.
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Charge/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Proof step: payment proof card + Charge, no payment method fields.
    expect(screen.getByText('Payment Proof')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.queryByText('Payment Proof')).not.toBeInTheDocument();
  });

  it('a PWD discount also routes through the Proof step, showing the discount ID proof card', () => {
    render(<CheckoutWorkspace {...baseProps()} layout="stepped" discountType="pwd" />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Payment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByText('Discount ID Proof')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Charge/ })).toBeInTheDocument();
  });

  // Task 209.29 (Part A root cause) — the base DialogContent className
  // (dialog.tsx) carries `overflow-y-auto`; both checkout layouts must
  // override it so the dialog chrome itself never becomes a second,
  // outer scroll container fighting the workspace's own inner scroll
  // regions (this was the real cause of "can't scroll" / "bottom action
  // unreachable" on real touch devices).
  it('the dialog element itself never scrolls (overflow-hidden) in either layout — only its inner regions do', () => {
    const { rerender } = render(<CheckoutWorkspace {...baseProps()} layout="two-pane" />);
    expect(screen.getByRole('dialog')).toHaveClass('overflow-hidden');
    expect(screen.getByRole('dialog')).not.toHaveClass('overflow-y-auto');

    rerender(<CheckoutWorkspace {...baseProps()} layout="stepped" />);
    expect(screen.getByRole('dialog')).toHaveClass('overflow-hidden');
    expect(screen.getByRole('dialog')).not.toHaveClass('overflow-y-auto');
  });
});
