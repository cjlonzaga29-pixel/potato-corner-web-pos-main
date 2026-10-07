import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { OrderTabContent } from './order-tabs-content';
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

afterEach(() => cleanup());

describe('OrderTabContent', () => {
  it('shows an empty message for an empty pending tab', () => {
    render(<OrderTabContent status="pending" entries={[]} busyKeys={new Set()} onRetry={vi.fn()} onRecheck={vi.fn()} onDismiss={vi.fn()} onViewReceipt={vi.fn()} />);
    expect(screen.getByText('Nothing pending')).toBeInTheDocument();
  });

  it('shows the terminal-local order reference for a pending entry, never the receipt number', () => {
    render(<OrderTabContent status="pending" entries={[entry()]} busyKeys={new Set()} onRetry={vi.fn()} onRecheck={vi.fn()} onDismiss={vi.fn()} onViewReceipt={vi.fn()} />);
    expect(screen.getByText('#03')).toBeInTheDocument();
    expect(screen.queryByText(/Receipt No\./)).not.toBeInTheDocument();
  });

  it('labels the clear action "Hide from list" on the Done tab', () => {
    const onDismiss = vi.fn();
    render(
      <OrderTabContent
        status="done"
        entries={[entry({ status: 'success', transaction: { id: 'txn-1' } as never })]}
        busyKeys={new Set()}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onDismiss={onDismiss}
        onViewReceipt={vi.fn()}
      />,
    );
    const hideButton = screen.getByRole('button', { name: 'Hide from list' });
    fireEvent.click(hideButton);
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'key-1' }));
  });

  it('explains that Done means the order is saved, not food preparation or inventory completion', () => {
    render(
      <OrderTabContent
        status="done"
        entries={[entry({ status: 'success', transaction: { id: 'txn-1' } as never })]}
        busyKeys={new Set()}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onDismiss={vi.fn()}
        onViewReceipt={vi.fn()}
      />,
    );
    expect(screen.getByText(/not that food is prepared or inventory has finished updating/i)).toBeInTheDocument();
  });

  // POS-PERF-P24 — the separate "Needs Action" tab was removed; a failed
  // order now stays persistently visible inside Pending with a red "Order
  // problem" label instead of a separate tab's "Needs attention" badge.
  it('labels the clear action "Dismiss" and shows "Order problem" for a failed entry on the Pending tab', () => {
    render(
      <OrderTabContent
        status="pending"
        entries={[entry({ status: 'error', errorMessage: 'Failed' })]}
        busyKeys={new Set()}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onDismiss={vi.fn()}
        onViewReceipt={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.getByText('Order problem')).toBeInTheDocument();
    expect(screen.getByText(/ask a supervisor/i)).toBeInTheDocument();
  });

  it('maps INSUFFICIENT_STOCK to "Not enough stock" and shows the server\'s detail verbatim', () => {
    render(
      <OrderTabContent
        status="pending"
        entries={[entry({ status: 'error', errorCode: 'INSUFFICIENT_STOCK', errorMessage: 'Insufficient stock for Fries: need 5, have 2 available' })]}
        busyKeys={new Set()}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onDismiss={vi.fn()}
        onViewReceipt={vi.fn()}
      />,
    );
    expect(screen.getByText('Not enough stock')).toBeInTheDocument();
    expect(screen.getByText('Insufficient stock for Fries: need 5, have 2 available')).toBeInTheDocument();
  });

  it('includes a failed entry in Pending counts alongside still-saving ones, and never discards it', () => {
    render(
      <OrderTabContent
        status="pending"
        entries={[entry({ status: 'saving' }), entry({ idempotencyKey: 'key-2', status: 'error', errorMessage: 'Failed' })]}
        busyKeys={new Set()}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onDismiss={vi.fn()}
        onViewReceipt={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Check status' })).toBeInTheDocument();
    expect(screen.getByText('Order problem')).toBeInTheDocument();
  });

  it('offers "Check status" (not Retry/Dismiss) for a still-saving pending entry', () => {
    render(
      <OrderTabContent
        status="pending"
        entries={[entry({ status: 'saving' })]}
        busyKeys={new Set()}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onDismiss={vi.fn()}
        onViewReceipt={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Check status' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('disables actions for a busy entry', () => {
    render(
      <OrderTabContent
        status="pending"
        entries={[entry({ status: 'error', errorMessage: 'Failed' })]}
        busyKeys={new Set(['key-1'])}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onDismiss={vi.fn()}
        onViewReceipt={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
  });
});
