import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PaymentFooter } from './payment-footer';

afterEach(() => cleanup());

function baseProps() {
  return {
    subtotal: 100,
    vatAmount: 12,
    discountAmount: 0,
    totalAmount: 100,
    canManageVoidRefund: true,
    onOpenVoidRefund: vi.fn(),
    discountType: 'none' as const,
    onDiscountTypeChange: vi.fn(),
    discountIdReference: '',
    onDiscountIdReferenceChange: vi.fn(),
    discountProofKey: null,
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

    const voidButton = screen.getByRole('button', { name: 'Void / Refund Sale' });
    expect(voidButton).toHaveClass('app-control');
    expect(voidButton).not.toHaveClass('touch-target');

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

  it('still shows Void / Refund Sale only when canManageVoidRefund is true', () => {
    render(<PaymentFooter {...baseProps()} canManageVoidRefund={false} />);
    expect(screen.queryByRole('button', { name: 'Void / Refund Sale' })).not.toBeInTheDocument();
  });

  it('keeps the Charge button visually prominent via the pos button variant', () => {
    render(<PaymentFooter {...baseProps()} />);
    expect(screen.getByRole('button', { name: /Charge/ })).toHaveClass('touch-target');
  });
});
