import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PaymentFooter } from './payment-footer';

afterEach(() => cleanup());

function baseProps() {
  return {
    totalAmount: 100,
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
    cashTendered: '100',
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

// Task 209.14 — checkout controls were switched from the fixed 48px
// `.touch-target` class to the density-aware `.app-control` class (compact
// on fine-pointer desktop/laptop, still >=44px on touch/mobile tiers) so the
// cart takes less vertical room without shrinking below the touch-safe
// floor. These tests guard that the swap didn't change any behavior.
describe('PaymentFooter — compact density controls (Task 209.14)', () => {
  it('renders checkout controls with the density-aware app-control class instead of the fixed touch-target floor', () => {
    render(<PaymentFooter {...baseProps()} />);

    const cashInput = screen.getByPlaceholderText('Cash tendered');
    expect(cashInput).toHaveClass('app-control');

    const paymentTabs = screen.getByRole('tablist');
    expect(paymentTabs).toHaveClass('app-control');
  });

  it('still fires onPaymentMethodChange, onDiscountTypeChange, and onCharge after the density change', () => {
    const props = baseProps();
    render(<PaymentFooter {...props} />);

    // Radix TabsTrigger activates on mousedown, not click (same reasoning as terminal/page.test.tsx's selectTab helper).
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'GCash' }));
    expect(props.onPaymentMethodChange).toHaveBeenCalledWith('gcash');

    fireEvent.click(screen.getByRole('button', { name: /Charge/ }));
    expect(props.onCharge).toHaveBeenCalled();
  });

  it('keeps the Charge button visually prominent via the pos button variant', () => {
    render(<PaymentFooter {...baseProps()} />);
    const chargeButton = screen.getByRole('button', { name: /Charge/ });
    // Task 209.20 — `pos` variant applies `.app-pos-cta` (see button.tsx),
    // which is what actually governs Charge's density-aware height now.
    expect(chargeButton).toHaveClass('app-pos-cta');
  });

  // Task 209.20 — `touch-target` used to sit alongside `.app-pos-cta` on the
  // Charge button and its fixed 48px min-height always won over the
  // density-aware token (48px > every `.app-pos-cta` tier value, including
  // comfortable/touch's 44px), so Charge never actually shrank on
  // fine-pointer desktop/laptop the way every other checkout control had
  // already been made to. This guards the fix: Charge relies purely on
  // `.app-pos-cta` for height now, like the rest of checkout.
  it('no longer forces the fixed 48px touch-target floor on Charge — height is density-aware via app-pos-cta alone', () => {
    render(<PaymentFooter {...baseProps()} />);
    expect(screen.getByRole('button', { name: /Charge/ })).not.toHaveClass('touch-target');
  });
});

// Task 209.20 — collapsed discount/payment proof summary: once a proof is
// attached, the full ImageUpload capture UI (Take Photo/Upload from Gallery,
// and any permanently-visible preview) must not stay mounted — a compact
// "attached" row with View/Replace/Remove replaces it, and expands back to
// ImageUpload only when the cashier clears the proof.
describe('PaymentFooter — collapsed proof summary (Task 209.20)', () => {
  it('shows the compact Take Photo/Upload row (not the attached summary) when no discount proof is attached', () => {
    render(<PaymentFooter {...baseProps()} discountType="pwd" discountProofKey={null} />);
    expect(screen.getByText('Discount ID Proof')).toBeInTheDocument();
    expect(screen.queryByText('Discount ID proof attached')).not.toBeInTheDocument();
  });

  it('collapses into a compact attached summary once a discount proof key is set, instead of staying expanded', () => {
    render(<PaymentFooter {...baseProps()} discountType="pwd" discountProofKey="proof-key-1" discountProofPreviewUrl="blob:discount-preview" />);
    expect(screen.getByText('Discount ID proof attached')).toBeInTheDocument();
    expect(screen.queryByText('Take Photo')).not.toBeInTheDocument();
  });

  it('offers View for a discount proof only when a preview URL is available, and opens it in a dialog', () => {
    render(<PaymentFooter {...baseProps()} discountType="pwd" discountProofKey="proof-key-1" discountProofPreviewUrl="blob:discount-preview" />);
    const viewButton = screen.getByRole('button', { name: /View/ });
    fireEvent.click(viewButton);
    expect(screen.getByRole('img', { name: 'Discount ID proof attached' })).toHaveAttribute('src', 'blob:discount-preview');
  });

  it('omits View when no discount proof preview URL is available (e.g. after a refresh)', () => {
    render(<PaymentFooter {...baseProps()} discountType="pwd" discountProofKey="proof-key-1" discountProofPreviewUrl={null} />);
    expect(screen.queryByRole('button', { name: /View/ })).not.toBeInTheDocument();
  });

  it('Replace calls onClearDiscountProof', () => {
    const props = baseProps();
    render(<PaymentFooter {...props} discountType="pwd" discountProofKey="proof-key-1" discountProofPreviewUrl="blob:discount-preview" />);
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(props.onClearDiscountProof).toHaveBeenCalled();
  });

  it('Remove calls onClearDiscountProof', () => {
    const props = baseProps();
    render(<PaymentFooter {...props} discountType="pwd" discountProofKey="proof-key-1" discountProofPreviewUrl="blob:discount-preview" />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove discount id proof attached' }));
    expect(props.onClearDiscountProof).toHaveBeenCalled();
  });

  it('collapses payment proof into a compact attached summary with working View/Replace/Remove', () => {
    const props = baseProps();
    render(
      <PaymentFooter
        {...props}
        paymentMethod="gcash"
        paymentProofKey="pay-proof-1"
        paymentProofPreviewUrl="blob:payment-preview"
      />,
    );
    expect(screen.getByText('Payment proof attached')).toBeInTheDocument();
    expect(screen.queryByText('Upload from Gallery')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /View/ }));
    expect(screen.getByRole('img', { name: 'Payment proof attached' })).toHaveAttribute('src', 'blob:payment-preview');
    // Radix Dialog marks the rest of the page aria-hidden while open, so
    // Replace/Remove below are unreachable by role query until it closes —
    // the same as a real cashier closing the preview before continuing.
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(props.onClearProof).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Remove payment proof attached' }));
    expect(props.onClearProof).toHaveBeenCalledTimes(2);
  });

  it('shows the plain ImageUpload capture row for payment proof when nothing is attached yet', () => {
    render(<PaymentFooter {...baseProps()} paymentMethod="gcash" paymentProofKey={null} />);
    expect(screen.getByText('Payment Proof')).toBeInTheDocument();
    expect(screen.queryByText('Payment proof attached')).not.toBeInTheDocument();
  });
});

// Task 209.23 — the discount/payment proof wrapper is shadcn's Card/
// CardContent, whose own default className already bakes in `p-4 sm:p-6`
// (card.tsx). `.app-pos-proof-padding` is a plain custom class, not a
// Tailwind utility twMerge recognizes as conflicting with that default, so
// merging it in via `cn()` left both paddings sitting on the same element
// with the winner decided by CSS cascade order instead of the density
// token. An inline style always wins over any class-based rule regardless
// of source order, so this guards that the token — not Card's built-in
// padding — is what actually governs this wrapper's spacing.
describe('PaymentFooter — proof card padding governed by the density token (Task 209.23)', () => {
  it('applies --app-pos-proof-padding as an inline style on the discount proof card, overriding CardContent defaults', () => {
    render(<PaymentFooter {...baseProps()} discountType="pwd" discountProofKey={null} />);
    const proofCard = screen.getByText('Discount ID Proof').closest('.app-pos-proof-padding');
    expect(proofCard).toHaveStyle({ padding: 'var(--app-pos-proof-padding)' });
  });

  it('applies --app-pos-proof-padding as an inline style on the payment proof card, overriding CardContent defaults', () => {
    render(<PaymentFooter {...baseProps()} paymentMethod="gcash" paymentProofKey={null} />);
    const proofCard = screen.getByText('Payment Proof').closest('.app-pos-proof-padding');
    expect(proofCard).toHaveStyle({ padding: 'var(--app-pos-proof-padding)' });
  });
});
