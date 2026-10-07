'use client';

import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import type { DetachedSale } from '@/lib/detached-sales';
import { formatOrderRef } from '@/lib/order-reference';
import { describeCashierFailure } from '@/lib/cashier-error-messages';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

export type OrdersTabStatus = 'pending' | 'done' | 'needs-action';

interface OrderTabContentProps {
  /** Which of the three order tabs is rendering — only used to pick the empty-state copy and the "Done"/"Needs Action" footnotes; filtering itself is the caller's job (page.tsx), since the caller is also the one computing the tab's own count badge from the exact same filtered list. */
  status: OrdersTabStatus;
  entries: DetachedSale[];
  /** True while a resolve/retry/recheck call for this specific entry is in flight — disables that entry's actions only, never the whole tab. */
  busyKeys: ReadonlySet<string>;
  onRetry: (entry: DetachedSale) => void;
  onRecheck: (entry: DetachedSale) => void;
  onDismiss: (entry: DetachedSale) => void;
  onViewReceipt: (entry: DetachedSale) => void;
}

/**
 * POS-PERF-P23 — inline tab content for one of the three order tabs
 * (Pending/Done/Needs Action), replacing the old "Orders" Dialog
 * (pending-sales-panel.tsx) whose own internal Tabs duplicated what the
 * terminal page's top-level tabs now do directly. Rendering/behavior per
 * entry (status icon, badge, failure detail, Retry/Recheck/Dismiss/View
 * Receipt actions) is otherwise unchanged from that panel.
 */
export function OrderTabContent({ status, entries, busyKeys, onRetry, onRecheck, onDismiss, onViewReceipt }: OrderTabContentProps) {
  return (
    <div className="space-y-3 p-3">
      {status === 'done' && (
        <p className="text-xs text-muted-foreground">Done means the order is saved — not that food is prepared or inventory has finished updating.</p>
      )}
      {entries.length === 0 ? (
        <EmptyState compact title={emptyTitle(status)} description={emptyDescription(status)} />
      ) : (
        <>
          <EntryList entries={entries} busyKeys={busyKeys} onRetry={onRetry} onRecheck={onRecheck} onDismiss={onDismiss} onViewReceipt={onViewReceipt} />
          {status === 'needs-action' && (
            <p className="text-xs text-muted-foreground">
              If Retry keeps failing for an order, ask a supervisor to check that order&apos;s reference number before starting it again as a new sale.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function emptyTitle(status: OrdersTabStatus): string {
  switch (status) {
    case 'pending':
      return 'Nothing pending';
    case 'done':
      return 'Nothing here yet';
    case 'needs-action':
      return 'Nothing needs action';
  }
}

function emptyDescription(status: OrdersTabStatus): string {
  switch (status) {
    case 'pending':
      return 'No orders are currently saving.';
    case 'done':
      return 'Confirmed orders appear here until you hide them.';
    case 'needs-action':
      return 'Every order has been confirmed or resolved.';
  }
}

interface EntryListProps {
  entries: DetachedSale[];
  busyKeys: ReadonlySet<string>;
  onRetry: (entry: DetachedSale) => void;
  onRecheck: (entry: DetachedSale) => void;
  onDismiss: (entry: DetachedSale) => void;
  onViewReceipt: (entry: DetachedSale) => void;
}

function EntryList({ entries, busyKeys, onRetry, onRecheck, onDismiss, onViewReceipt }: EntryListProps) {
  return (
    <div className="space-y-3">
      {entries.map((entry) => {
        const isBusy = busyKeys.has(entry.idempotencyKey);
        const failure = entry.status === 'error' ? describeCashierFailure(entry.errorCode ?? null, entry.errorMessage ?? 'Unknown error') : null;
        return (
          <div key={entry.idempotencyKey} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {entry.status === 'saving' && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
                {entry.status === 'error' && <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />}
                {entry.status === 'success' && <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />}
                {/* POS-PERF-P21 — the same terminal-local reference shown on the sale popup (sale-status-modal.tsx) — never the receipt number. */}
                <span className="text-sm font-semibold">{formatOrderRef(entry.snapshot.orderRef)}</span>
              </div>
              <Badge variant={entry.status === 'success' ? 'active' : entry.status === 'error' ? 'destructive' : 'outline'}>
                {entry.status === 'saving' ? 'Saving' : entry.status === 'error' ? 'Needs attention' : 'Confirmed'}
              </Badge>
            </div>

            <p className="text-xs text-muted-foreground">
              {entry.status === 'saving' && 'Saving your order. '}
              {entry.status === 'success' && 'Order saved. '}
              {entry.snapshot.items.length} item{entry.snapshot.items.length === 1 ? '' : 's'} · {formatPeso(entry.snapshot.totalAmount)} ·{' '}
              {new Date(entry.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
            </p>

            {failure && (
              <div className="space-y-0.5">
                <p className="text-xs font-semibold text-destructive">{failure.title}</p>
                <p className="text-xs text-destructive">{failure.detail}</p>
              </div>
            )}

            <div className="flex gap-2">
              {entry.status === 'saving' && (
                <Button size="sm" variant="outline" className="flex-1" disabled={isBusy} onClick={() => onRecheck(entry)}>
                  {isBusy ? <LoaderInline /> : 'Check status'}
                </Button>
              )}
              {entry.status === 'error' && (
                <>
                  <Button size="sm" className="flex-1" disabled={isBusy} onClick={() => onRetry(entry)}>
                    {isBusy ? <LoaderInline /> : 'Retry'}
                  </Button>
                  <Button size="sm" variant="outline" className="flex-1" disabled={isBusy} onClick={() => onDismiss(entry)}>
                    Dismiss
                  </Button>
                </>
              )}
              {entry.status === 'success' && (
                <>
                  <Button size="sm" variant="outline" className="flex-1" onClick={() => onViewReceipt(entry)}>
                    View Receipt
                  </Button>
                  {/* POS-PERF-P22 — "Hide from list": confirmed entries only
                      (unlike the 'error' Dismiss above), never resolves
                      anything against the server first — the sale is
                      already confirmed, so hiding it just stops tracking it
                      locally (see handleDismissDetachedSale's early-return
                      for status === 'success'). */}
                  <Button size="sm" variant="ghost" className="flex-1" onClick={() => onDismiss(entry)}>
                    Hide from list
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LoaderInline() {
  return <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />;
}
