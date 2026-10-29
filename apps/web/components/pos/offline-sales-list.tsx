'use client';

import { AlertTriangle, CheckCircle2, CloudOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { describeCashierFailure } from '@/lib/cashier-error-messages';
import type { OfflineTransaction } from '@/lib/offline/sync-queue';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export type OfflineSaleState = 'synced' | 'rejected' | 'waiting' | 'other-cashier' | 'cashier-unknown';

/** Which situation a queued row is in for the cashier now at the terminal — mirrors isOfflineSaleEligible in sync-queue.ts. */
export function offlineSaleState(sale: OfflineTransaction, currentCashierId: string | null): OfflineSaleState {
  if (sale.syncedAt !== null) return 'synced';
  if (sale.rejection) return 'rejected';
  if (!sale.cashierUserId) return 'cashier-unknown';
  return sale.cashierUserId === currentCashierId ? 'waiting' : 'other-cashier';
}

interface OfflineSalesListProps {
  status: 'pending' | 'done';
  /** Already filtered by the caller to this tab (unsynced for Pending, synced for Done). */
  sales: OfflineTransaction[];
  currentCashierId: string | null;
  isOnline: boolean;
  isSyncing: boolean;
  onSyncNow: () => void;
  onRetry: (id: string) => void;
}

/**
 * P46R3 — the offline queue in the Pending/Done tabs (was console-only). A
 * queued sale was already paid, so nothing here deletes it, edits it or
 * re-rings it: the only actions resend the very same queued sale under its
 * own provisional number, which the server's replay guard makes safe.
 */
export function OfflineSalesList({ status, sales, currentCashierId, isOnline, isSyncing, onSyncNow, onRetry }: OfflineSalesListProps) {
  if (sales.length === 0) return null;
  const hasWaiting = sales.some((sale) => offlineSaleState(sale, currentCashierId) === 'waiting');
  return (
    <section className="space-y-3 px-3 pt-3" aria-label={status === 'pending' ? 'Offline sales waiting to sync' : 'Offline sales synced'}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{status === 'pending' ? 'Offline sales' : 'Offline sales synced'}</h3>
        {status === 'pending' && hasWaiting && (
          <Button size="sm" variant="outline" disabled={!isOnline || isSyncing} onClick={onSyncNow}>
            {isSyncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : 'Sync now'}
          </Button>
        )}
      </div>
      {sales.map((sale) => (
        <OfflineSaleRow
          key={sale.id}
          sale={sale}
          state={offlineSaleState(sale, currentCashierId)}
          isOwnSale={Boolean(sale.cashierUserId) && sale.cashierUserId === currentCashierId}
          isOnline={isOnline}
          isSyncing={isSyncing}
          onRetry={onRetry}
        />
      ))}
    </section>
  );
}

interface OfflineSaleRowProps {
  sale: OfflineTransaction;
  state: OfflineSaleState;
  /** Retry sends a row only under the token of the cashier who rang it. */
  isOwnSale: boolean;
  isOnline: boolean;
  isSyncing: boolean;
  onRetry: (id: string) => void;
}

function OfflineSaleRow({ sale, state, isOwnSale, isOnline, isSyncing, onRetry }: OfflineSaleRowProps) {
  const itemCount = sale.summary?.itemCount ?? sale.payload.items.reduce((sum, item) => sum + item.quantity, 0);
  const rejection = sale.rejection ? describeCashierFailure(sale.rejection.code, sale.rejection.message ?? 'The server refused this sale.') : null;
  const lastError = state === 'waiting' && sale.lastError ? describeCashierFailure(sale.lastError.code, sale.lastError.message ?? 'No answer from the server.') : null;
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="offline-sale">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {state === 'synced' && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />}
          {(state === 'rejected' || state === 'cashier-unknown') && <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />}
          {(state === 'waiting' || state === 'other-cashier') && <CloudOff className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="break-all text-sm font-semibold">{sale.id}</span>
        </div>
        <Badge variant={state === 'synced' ? 'active' : state === 'rejected' || state === 'cashier-unknown' ? 'destructive' : 'outline'}>
          {state === 'synced' ? 'Synced' : state === 'rejected' ? 'Not accepted' : state === 'cashier-unknown' ? 'Cashier not recorded' : 'Waiting to sync'}
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        {itemCount} item{itemCount === 1 ? '' : 's'}
        {sale.summary ? ` · ${formatPeso(sale.summary.totalAmount)}` : ''} · {formatTime(sale.createdAt)}
        {sale.cashierName ? ` · ${sale.cashierName}` : ''}
      </p>

      {state === 'synced' && sale.officialTransactionNumber && (
        <p className="text-xs">
          Receipt <span className="font-medium">{sale.officialTransactionNumber}</span>
        </p>
      )}

      {rejection && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-destructive">{rejection.title}</p>
          <p className="text-xs text-destructive">{rejection.detail}</p>
          <p className="text-xs text-muted-foreground">
            This sale was paid offline but the server did not record it. It will not be sent again on its own. Ask a supervisor to check this product&apos;s
            options, then tap Retry. It stays saved on this device.
          </p>
        </div>
      )}

      {state === 'cashier-unknown' && (
        <div className="space-y-1">
          <p className="text-xs text-destructive">
            Rung up offline before this terminal was updated, when the cashier&apos;s name was not saved. It will not be sent under anyone else&apos;s name,
            so it is not in sales yet.
          </p>
          <p className="text-xs text-muted-foreground">
            Give a supervisor this ID, the time and the amount collected so they can account for it. Keep this device&apos;s browser data — clearing it
            deletes the record.
          </p>
        </div>
      )}

      {state === 'other-cashier' && (
        <p className="text-xs text-muted-foreground">Syncs when {sale.cashierName ?? 'the cashier who rang it'} is signed in at this terminal.</p>
      )}

      {lastError && (
        <p className="text-xs text-muted-foreground">
          Last try: {lastError.title}. {lastError.detail} It is tried again when the device reconnects, or with Sync now.
        </p>
      )}

      {state === 'rejected' && !isOwnSale && (
        <p className="text-xs text-muted-foreground">Retry is available when {sale.cashierName ?? 'the cashier who rang it'} is signed in at this terminal.</p>
      )}

      {state === 'rejected' && isOwnSale && (
        <Button size="sm" className="w-full" disabled={!isOnline || isSyncing} onClick={() => onRetry(sale.id)}>
          {isSyncing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : 'Retry'}
        </Button>
      )}
    </div>
  );
}
