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
    safeToRetryDirectly: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('PendingSalesPanel', () => {
  it('shows the terminal-local order reference, never the receipt number, on every entry', () => {
    render(
      <PendingSalesPanel
        open
        onOpenChange={vi.fn()}
        entries={[entry()]}
        busyKeys={new Set()}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onDismiss={vi.fn()}
        onViewReceipt={vi.fn()}
      />,
    );

    expect(screen.getByText('#03')).toBeInTheDocument();
    expect(screen.queryByText(/Receipt No\./)).not.toBeInTheDocument();
  });

  // POS-PERF-P21 — confirmed entries say "Clear from list" (a local-only
  // action, no server resolve needed — the sale is already confirmed);
  // unresolved 'error' entries keep "Dismiss" (which does resolve against
  // the server first — see page.tsx's handleDismissDetachedSale).
  it('labels the clear action "Clear from list" for a confirmed entry, and "Dismiss" for a failed one', () => {
    const onDismiss = vi.fn();
    render(
      <PendingSalesPanel
        open
        onOpenChange={vi.fn()}
        entries={[
          entry({ idempotencyKey: 'key-success', status: 'success', transaction: { id: 'txn-1' } as never }),
          entry({ idempotencyKey: 'key-error', status: 'error', errorMessage: 'Not confirmed.' }),
        ]}
        busyKeys={new Set()}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onDismiss={onDismiss}
        onViewReceipt={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Clear from list' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear from list' }));
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'key-success' }));
  });

  it('shows "Needs attention" for an error entry', () => {
    render(
      <PendingSalesPanel
        open
        onOpenChange={vi.fn()}
        entries={[entry({ status: 'error', errorMessage: 'Failed' })]}
        busyKeys={new Set()}
        onRetry={vi.fn()}
        onRecheck={vi.fn()}
        onDismiss={vi.fn()}
        onViewReceipt={vi.fn()}
      />,
    );

    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });
});
