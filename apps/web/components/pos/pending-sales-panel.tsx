'use client';

import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import type { DetachedSale } from '@/lib/detached-sales';

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

/**
 * POS-PERF-P19 — every order the cashier detached from via "New Sale" while
 * the previous charge was still saving (see lib/detached-sales.ts and
 * sale-status-modal.tsx's 'saving'-phase New Sale button). Each entry's
 * status updates independently in the background; this panel is the only
 * place a detached order's outcome is surfaced once the cashier has moved
 * on from it, so a failure here must stay actionable (Retry/Recheck) and a
 * success must stay reachable (View Receipt) rather than disappearing.
 */
export function PendingSalesPanel({ open, onOpenChange, entries, busyKeys, onRetry, onRecheck, onDismiss, onViewReceipt }: PendingSalesPanelProps) {
  const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pending Sales</DialogTitle>
          <DialogDescription>Orders you moved on from with New Sale while they were still saving.</DialogDescription>
        </DialogHeader>

        {sorted.length === 0 ? (
          <EmptyState compact title="Nothing pending" description="Every detached sale has been confirmed or resolved." />
        ) : (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto">
            {sorted.map((entry) => {
              const isBusy = busyKeys.has(entry.idempotencyKey);
              return (
                <div key={entry.idempotencyKey} className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {entry.status === 'saving' && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
                      {entry.status === 'error' && <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />}
                      {entry.status === 'success' && <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />}
                      <span className="text-sm font-medium tabular-nums">{formatPeso(entry.snapshot.totalAmount)}</span>
                    </div>
                    <Badge variant={entry.status === 'success' ? 'active' : entry.status === 'error' ? 'destructive' : 'outline'}>
                      {entry.status === 'saving' ? 'Saving' : entry.status === 'error' ? 'Needs attention' : 'Confirmed'}
                    </Badge>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {entry.snapshot.items.length} item{entry.snapshot.items.length === 1 ? '' : 's'} ·{' '}
                    {new Date(entry.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
                  </p>

                  {entry.status === 'error' && entry.errorMessage && <p className="text-xs text-destructive">{entry.errorMessage}</p>}

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
                        <Button size="sm" variant="ghost" className="flex-1" onClick={() => onDismiss(entry)}>
                          Dismiss
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LoaderInline() {
  return <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />;
}
