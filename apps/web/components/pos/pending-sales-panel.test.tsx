import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PendingSalesPanel } from './pending-sales-panel';
import type { DetachedSale } from '@/lib/detached-sales';

function entry(overrides: Partial<DetachedSale> = {}): DetachedSale {
  return {
    idempotencyKey: 'key-1',
    snapshot: {
      orderRef: 3,
      items: [{ id: 'line-1', productName: 'Cheese', variantName: 'Regular', flavorName: null, quantity: 1, lineTotal: 60, optionSelections: [] }],
      subtotal: 60,
      discountAmount: 0,
      discountType: null,
      vatAmount: 6.43,
      totalAmount: 60,
      paymentMethod: 'cash',
      cashTendered: 60,
      changeGiven: 0,
    },
    payload: { branch_id: 'branch-1', items: [], payment_method: 'cash' } as never,
    status: 'saving',
    transaction: null,
    errorMessage: null,
    errorCode: null,
    safeToRetryDirectly: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

function renderPanel(entries: DetachedSale[], onDismiss = vi.fn()) {
  render(
    <PendingSalesPanel
      open
      onOpenChange={vi.fn()}
      entries={entries}
      busyKeys={new Set()}
      onRetry={vi.fn()}
      onRecheck={vi.fn()}
      onDismiss={onDismiss}
      onViewReceipt={vi.fn()}
    />,
  );
}

afterEach(() => cleanup());

describe('PendingSalesPanel ("Orders")', () => {
  it('titles the dialog "Orders" with Pending/Done/Needs Action sections', () => {
    renderPanel([entry()]);
    expect(screen.getByText('Orders')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Pending/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Done/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Needs Action/ })).toBeInTheDocument();
  });

  it('shows each section\'s count in its tab', () => {
    renderPanel([
      entry({ idempotencyKey: 'a', status: 'saving' }),
      entry({ idempotencyKey: 'b', status: 'success', transaction: { id: 'txn-1' } as never }),
      entry({ idempotencyKey: 'c', status: 'error', errorMessage: 'Failed' }),
      entry({ idempotencyKey: 'd', status: 'error', errorMessage: 'Failed again' }),
    ]);
    expect(screen.getByRole('tab', { name: 'Pending (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Done (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Needs Action (2)' })).toBeInTheDocument();
  });

  it('defaults to the Needs Action tab when something has failed, and shows the terminal-local order reference, never the receipt number', () => {
    renderPanel([entry({ status: 'error', errorMessage: 'Failed' })]);
    expect(screen.getByText('#03')).toBeInTheDocument();
    expect(screen.queryByText(/Receipt No\./)).not.toBeInTheDocument();
  });

  it('labels the clear action "Hide from list" for a confirmed entry (Done tab), and "Dismiss" for a failed one (Needs Action tab)', () => {
    const onDismiss = vi.fn();
    renderPanel(
      [
        entry({ idempotencyKey: 'key-success', status: 'success', transaction: { id: 'txn-1' } as never }),
        entry({ idempotencyKey: 'key-error', status: 'error', errorMessage: 'Not confirmed.' }),
      ],
      onDismiss,
    );

    // Defaults to Needs Action since a failure exists.
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();

    // Radix TabsTrigger activates on mousedown, not click (same reasoning as terminal/page.test.tsx's selectTab helper).
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Done/ }));
    const hideButton = screen.getByRole('button', { name: 'Hide from list' });
    expect(hideButton).toBeInTheDocument();
    fireEvent.click(hideButton);
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'key-success' }));
  });

  it('shows "Needs attention" for an error entry', () => {
    renderPanel([entry({ status: 'error', errorMessage: 'Failed' })]);
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('maps INSUFFICIENT_STOCK to "Not enough stock" and shows the server\'s item/quantity detail verbatim', () => {
    renderPanel([
      entry({
        status: 'error',
        errorCode: 'INSUFFICIENT_STOCK',
        errorMessage: 'Insufficient stock for Fries: need 5, have 2 available',
      }),
    ]);
    expect(screen.getByText('Not enough stock')).toBeInTheDocument();
    expect(screen.getByText('Insufficient stock for Fries: need 5, have 2 available')).toBeInTheDocument();
  });

  it('maps an uncertain/network outcome to "Connection problem — checking order status" rather than claiming the order was not saved', () => {
    renderPanel([
      entry({
        status: 'error',
        errorCode: 'CONNECTION_UNCERTAIN',
        errorMessage: 'Could not confirm whether this went through. Check your connection, then retry.',
      }),
    ]);
    expect(screen.getByText('Connection problem — checking order status')).toBeInTheDocument();
    expect(screen.queryByText(/order not saved/i)).not.toBeInTheDocument();
  });

  it('keeps a stock failure visible in Needs Action rather than relying on a toast', () => {
    renderPanel([
      entry({
        status: 'error',
        errorCode: 'INSUFFICIENT_STOCK',
        errorMessage: 'Insufficient stock for Fries: need 5, have 2 available',
      }),
    ]);
    // Still present after "time passes" (no timers involved) — this is a
    // persistent panel entry, not an auto-dismissing toast.
    expect(screen.getByText('Not enough stock')).toBeInTheDocument();
  });

  it('Needs Action offers supervisor guidance alongside the existing Retry/Dismiss actions, without inventing a cart-recovery button', () => {
    renderPanel([entry({ status: 'error', errorMessage: 'Failed' })]);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Review Items/ })).not.toBeInTheDocument();
    expect(screen.getByText(/ask a supervisor/i)).toBeInTheDocument();
  });

  it('explains that Done means the order is saved, not food preparation or inventory completion', () => {
    renderPanel([entry({ status: 'success', transaction: { id: 'txn-1' } as never })]);
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Done/ }));
    expect(screen.getByText(/not that food is prepared or inventory has finished updating/i)).toBeInTheDocument();
  });
});
