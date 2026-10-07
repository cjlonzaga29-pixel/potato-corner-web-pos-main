import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SaleStatusModal, type SaleSnapshot } from './sale-status-modal';

function snapshot(overrides: Partial<SaleSnapshot> = {}): SaleSnapshot {
  return {
    orderRef: 1,
    items: [
      { id: 'line-1', productName: 'Classic Cheese', variantName: 'Large', flavorName: 'Regular', quantity: 2, lineTotal: 120, optionSelections: [] },
    ],
    subtotal: 120,
    discountAmount: 0,
    discountType: null,
    vatAmount: 12.86,
    totalAmount: 120,
    paymentMethod: 'cash',
    cashTendered: 150,
    changeGiven: 30,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SaleStatusModal', () => {
  it('saving phase: shows "Saving order…", a disabled Saving button, and no close (X) button', () => {
    render(
      <SaleStatusModal
        phase="saving"
        snapshot={snapshot()}
        errorMessage={null}
        onRetry={vi.fn()}
        onEditCart={vi.fn()}
        onViewReceipt={vi.fn()}
        onNewSale={vi.fn()}
      />,
    );

    expect(screen.getByText('Saving order…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Saving…/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Close$/ })).not.toBeInTheDocument();
    // The submitted order is already visible — no receipt number invented
    // anywhere on this phase.
    expect(screen.getByText('Classic Cheese', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/Receipt No\./)).not.toBeInTheDocument();
  });

  // POS-PERF-P19/P21 — the fix for the cashier-blocking regression: "Next
  // Customer" (formerly "New Sale") must be clickable immediately during
  // 'saving', not just once the server responds. It must also be clearly
  // labeled pending, never implying completion, and show the terminal-local
  // order reference (never the receipt number).
  it('saving phase: Next Customer is enabled immediately and wired to its handler, and the order is clearly labeled pending', () => {
    const onNewSale = vi.fn();
    render(
      <SaleStatusModal
        phase="saving"
        snapshot={snapshot()}
        errorMessage={null}
        onRetry={vi.fn()}
        onEditCart={vi.fn()}
        onViewReceipt={vi.fn()}
        onNewSale={onNewSale}
      />,
    );

    expect(screen.getByText(/Pending confirmation/)).toBeInTheDocument();
    expect(screen.queryByText('Sale completed')).not.toBeInTheDocument();
    expect(screen.getByText(/Order #01/)).toBeInTheDocument();

    const nextCustomerButton = screen.getByRole('button', { name: 'Next Customer' });
    expect(nextCustomerButton).not.toBeDisabled();
    fireEvent.click(nextCustomerButton);
    expect(onNewSale).toHaveBeenCalledTimes(1);
  });

  it('error phase: shows the error message and wires Retry/Edit Cart to their handlers, never clearing the submitted order', () => {
    const onRetry = vi.fn();
    const onEditCart = vi.fn();
    render(
      <SaleStatusModal
        phase="error"
        snapshot={snapshot()}
        errorMessage="Network request failed"
        onRetry={onRetry}
        onEditCart={onEditCart}
        onViewReceipt={vi.fn()}
        onNewSale={vi.fn()}
      />,
    );

    expect(screen.getByText("Couldn't save sale")).toBeInTheDocument();
    expect(screen.getByText('Network request failed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Cart' }));
    expect(onEditCart).toHaveBeenCalledTimes(1);
  });

  it('error phase: falls back to a generic message when none is provided', () => {
    render(
      <SaleStatusModal
        phase="error"
        snapshot={snapshot()}
        errorMessage={null}
        onRetry={vi.fn()}
        onEditCart={vi.fn()}
        onViewReceipt={vi.fn()}
        onNewSale={vi.fn()}
      />,
    );

    expect(screen.getByText(/Something went wrong\. Your cart is still here/)).toBeInTheDocument();
  });

  it('success phase: shows "Sale completed" with View Receipt / New Sale wired to their handlers', () => {
    const onViewReceipt = vi.fn();
    const onNewSale = vi.fn();
    render(
      <SaleStatusModal
        phase="success"
        snapshot={snapshot()}
        errorMessage={null}
        onRetry={vi.fn()}
        onEditCart={vi.fn()}
        onViewReceipt={onViewReceipt}
        onNewSale={onNewSale}
      />,
    );

    expect(screen.getByText('Sale completed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'View Receipt' }));
    expect(onViewReceipt).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Next Customer' }));
    expect(onNewSale).toHaveBeenCalledTimes(1);
  });

  it('never renders a dismiss (X) button on any phase — only explicit actions', () => {
    for (const phase of ['saving', 'error', 'success'] as const) {
      const { unmount } = render(
        <SaleStatusModal
          phase={phase}
          snapshot={snapshot()}
          errorMessage={phase === 'error' ? 'failed' : null}
          onRetry={vi.fn()}
          onEditCart={vi.fn()}
          onViewReceipt={vi.fn()}
          onNewSale={vi.fn()}
        />,
      );
      expect(screen.queryByText('Close')).not.toBeInTheDocument();
      unmount();
    }
  });
});
