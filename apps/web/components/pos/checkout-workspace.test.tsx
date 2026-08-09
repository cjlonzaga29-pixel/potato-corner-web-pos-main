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
});
