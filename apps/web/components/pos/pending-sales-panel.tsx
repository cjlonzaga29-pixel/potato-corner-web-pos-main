'use client';

import { useState, useMemo, useEffect } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import type { DetachedSale } from '@/lib/detached-sales';
import { formatOrderRef } from '@/lib/order-reference';
import { describeCashierFailure } from '@/lib/cashier-error-messages';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

interface PendingSalesPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: DetachedSale[];
  /** True while a resolve/retry/recheck call for this specific entry is in flight — disables that entry's actions only, never the whole panel. */
  busyKeys: ReadonlySet<string>;
  onRetry: (entry: DetachedSale) => void;
  onRecheck: (entry: DetachedSale) => void;
  onDismiss: (entry: DetachedSale) => void;
  onViewReceipt: (entry: DetachedSale) => void;
}

type OrdersTab = 'pending' | 'done' | 'needs-action';

/**
 * POS-PERF-P22 — renamed from a flat "Pending Sales" list to "Orders" with
 * three sections (Pending/Done/Needs Action, mirroring DetachedSale.status
 * 'saving'/'success'/'error' 1:1 — this only changes what the cashier reads,
 * never the underlying status values or storage shape). Every order the
 * cashier detached from via "New Sale"/"Next Customer" while the previous
 * charge was still saving (see lib/detached-sales.ts and
 * sale-status-modal.tsx's 'saving'-phase Next Customer button) lives here.
 * Each entry's status updates independently in the background; this panel
 * is the only place a detached order's outcome is surfaced once the
 * cashier has moved on from it, so a failure here must stay actionable
 * (Retry/Dismiss) and a success must stay reachable (View Receipt) rather
 * than disappearing.
 */
export function PendingSalesPanel({ open, onOpenChange, entries, busyKeys, onRetry, onRecheck, onDismiss, onViewReceipt }: PendingSalesPanelProps) {
  const pending = useMemo(() => entries.filter((e) => e.status === 'saving').sort((a, b) => b.createdAt - a.createdAt), [entries]);
  const done = useMemo(() => entries.filter((e) => e.status === 'success').sort((a, b) => b.createdAt - a.createdAt), [entries]);
  const needsAction = useMemo(() => entries.filter((e) => e.status === 'error').sort((a, b) => b.createdAt - a.createdAt), [entries]);

  // Default to whichever tab most needs the cashier's attention: a failure
  // first, then anything still saving, then the confirmed list. This panel
  // stays mounted (with `open` toggling the Dialog, not the component) for
  // the whole terminal session, so the default can't be computed once at
  // mount — it's recomputed every time the dialog actually opens, against
  // whatever entries exist at that moment.
  const [tab, setTab] = useState<OrdersTab>('needs-action');
  useEffect(() => {
    if (!open) return;
    setTab(needsAction.length > 0 ? 'needs-action' : pending.length > 0 ? 'pending' : 'done');
    // Deliberately `open`-only — this is meant to reset the default exactly
    // once per open, not re-snap the cashier's own tab choice every time an
    // entry updates while the panel is already open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Orders</DialogTitle>
          <DialogDescription>Orders you moved on from with Next Customer while they were still saving.</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(value) => setTab(value as OrdersTab)}>
          <TabsList className="w-full">
            <TabsTrigger value="pending" className="flex-1">
              Pending{pending.length > 0 ? ` (${pending.length})` : ''}
            </TabsTrigger>
            <TabsTrigger value="done" className="flex-1">
              Done{done.length > 0 ? ` (${done.length})` : ''}
            </TabsTrigger>
            <TabsTrigger value="needs-action" className="flex-1">
              Needs Action{needsAction.length > 0 ? ` (${needsAction.length})` : ''}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pending">
            {pending.length === 0 ? (
              <EmptyState compact title="Nothing pending" description="No orders are currently saving." />
            ) : (
              <EntryList entries={pending} busyKeys={busyKeys} onRetry={onRetry} onRecheck={onRecheck} onDismiss={onDismiss} onViewReceipt={onViewReceipt} />
            )}
          </TabsContent>

          <TabsContent value="done">
            {/* POS-PERF-P22 — "Done" means the sale itself is saved; it is
                deliberately not a claim about food preparation or about the
                background inventory deduction job, both of which complete
                independently on the server. */}
            <p className="mb-2 text-xs text-muted-foreground">Done means the order is saved — not that food is prepared or inventory has finished updating.</p>
            {done.length === 0 ? (
              <EmptyState compact title="Nothing here yet" description="Confirmed orders appear here until you hide them." />
            ) : (
              <EntryList entries={done} busyKeys={busyKeys} onRetry={onRetry} onRecheck={onRecheck} onDismiss={onDismiss} onViewReceipt={onViewReceipt} />
            )}
          </TabsContent>

          <TabsContent value="needs-action">
            {needsAction.length === 0 ? (
              <EmptyState compact title="Nothing needs action" description="Every order has been confirmed or resolved." />
            ) : (
              <>
                <EntryList entries={needsAction} busyKeys={busyKeys} onRetry={onRetry} onRecheck={onRecheck} onDismiss={onDismiss} onViewReceipt={onViewReceipt} />
                <p className="mt-3 text-xs text-muted-foreground">
                  If Retry keeps failing for an order, ask a supervisor to check that order&apos;s reference number before starting it again as a new sale.
                </p>
              </>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
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
    <div className="max-h-[55vh] space-y-3 overflow-y-auto">
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
                  {/* POS-PERF-P22 — renamed from "Clear from list"; confirmed
                      entries only (unlike the 'error' Dismiss above), this
                      never resolves anything against the server first — the
                      sale is already confirmed, so hiding it just stops
                      tracking it locally (see handleDismissDetachedSale's
                      early-return for status === 'success'). */}
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
