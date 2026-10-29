import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { OfflineTransaction } from '@/lib/offline/sync-queue';
import { OfflineSalesList, offlineSaleState } from './offline-sales-list';

function sale(overrides: Partial<OfflineTransaction> = {}): OfflineTransaction {
  return {
    id: 'PC-MAIN01-20261029-OFFLINE-0001',
    payload: {
      branch_id: 'branch-1',
      shift_id: 'shift-1',
      items: [{ product_id: 'p', product_variant_id: 'v', quantity: 2 }],
      payment_method: 'cash',
      cash_tendered: 500,
      is_offline_transaction: true,
    } as OfflineTransaction['payload'],
    createdAt: Date.now(),
    syncedAt: null,
    officialTransactionNumber: null,
    cashierUserId: 'alice',
    cashierName: 'Alice Cruz',
    summary: { itemCount: 2, totalAmount: 200 },
    ...overrides,
  };
}

const props = { currentCashierId: 'alice', isOnline: true, isSyncing: false, onSyncNow: vi.fn(), onRetry: vi.fn() };

afterEach(() => cleanup());

describe('offlineSaleState', () => {
  it('classifies each row for the cashier now at the terminal', () => {
    expect(offlineSaleState(sale({ syncedAt: 1 }), 'alice')).toBe('synced');
    expect(offlineSaleState(sale({ rejection: { code: 'PRODUCT_OPTION_REQUIRED', message: null, at: 1 } }), 'alice')).toBe('rejected');
    expect(offlineSaleState(sale(), 'alice')).toBe('waiting');
    expect(offlineSaleState(sale(), 'bob')).toBe('other-cashier');
    // Never "waiting" for whoever is signed in — on any kind of login.
    expect(offlineSaleState(sale({ cashierUserId: undefined }), 'alice')).toBe('cashier-unknown');
  });
});

describe('OfflineSalesList', () => {
  it('shows a refused sale with its reason and Retry for its own cashier, never as synced', () => {
    const onRetry = vi.fn();
    render(
      <OfflineSalesList
        {...props}
        onRetry={onRetry}
        status="pending"
        sales={[sale({ rejection: { code: 'PRODUCT_OPTION_REQUIRED', message: 'Regular needs 1 Dips selection', at: 1 } })]}
      />,
    );
    expect(screen.getByText('Not accepted')).toBeInTheDocument();
    expect(screen.getByText('Required choice missing')).toBeInTheDocument();
    expect(screen.getByText('Regular needs 1 Dips selection')).toBeInTheDocument();
    expect(screen.getByText(/will not be sent again on its own/)).toBeInTheDocument();
    expect(screen.queryByText('Synced')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith('PC-MAIN01-20261029-OFFLINE-0001');
  });

  it("offers no Retry on another cashier's refused sale", () => {
    render(
      <OfflineSalesList {...props} currentCashierId="bob" status="pending" sales={[sale({ rejection: { code: 'PRODUCT_OPTION_REQUIRED', message: null, at: 1 } })]} />,
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByText(/Retry is available when Alice Cruz is signed in/)).toBeInTheDocument();
  });

  it('shows a retryable failure as still waiting, with its last reason and Sync now', () => {
    const onSyncNow = vi.fn();
    render(
      <OfflineSalesList {...props} onSyncNow={onSyncNow} status="pending" sales={[sale({ lastError: { code: 'NETWORK_ERROR', message: 'Could not reach the server.', at: 1 } })]} />,
    );
    expect(screen.getByText('Waiting to sync')).toBeInTheDocument();
    expect(screen.getByText(/Last try:/)).toHaveTextContent('Could not reach the server.');
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(onSyncNow).toHaveBeenCalled();
  });

  it('keeps a pre-P46R3 row without a cashier visible with what to do, and offers no action', () => {
    render(<OfflineSalesList {...props} status="pending" sales={[sale({ cashierUserId: undefined, cashierName: undefined, summary: undefined })]} />);
    expect(screen.getByText('Cashier not recorded')).toBeInTheDocument();
    expect(screen.getByText(/will not be sent under anyone else/)).toBeInTheDocument();
    expect(screen.getByText(/Give a supervisor this ID, the time and the amount collected/)).toBeInTheDocument();
    expect(screen.getByText(/2 items/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a synced sale with its official receipt number in Done', () => {
    render(<OfflineSalesList {...props} status="done" sales={[sale({ syncedAt: Date.now(), officialTransactionNumber: 'MAIN01-20261029-000007' })]} />);
    expect(screen.getByText('Synced')).toBeInTheDocument();
    expect(screen.getByText('MAIN01-20261029-000007')).toBeInTheDocument();
  });

  it('renders nothing for an empty queue', () => {
    const { container } = render(<OfflineSalesList {...props} status="pending" sales={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
