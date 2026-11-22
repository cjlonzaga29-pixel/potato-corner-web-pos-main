'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import type { BranchClosureItem } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import {
  useClosureItems,
  useReconcileClosureItem,
} from '@/hooks/queries/use-branch-force-deletion';
import { formatDateTime } from '@/lib/utils';

const PAGE_SIZE = 25;

/**
 * POS-PERF-P68 — what a Force Delete left unresolved (uncounted shifts,
 * clock-ins without a clock-out, stock on hand, draft payroll, cancelled
 * deductions…), read-only, with one supported action: record how it was
 * settled. The original records are never changed here.
 */
export default function ClosureItemsPage() {
  const [reconciled, setReconciled] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<BranchClosureItem | null>(null);
  const { data, isLoading, isError, refetch } = useClosureItems({
    reconciled,
    page,
    limit: PAGE_SIZE,
  });
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="app-section app-section-gap">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link href="/admin/branches">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to branches
        </Link>
      </Button>
      <div>
        <h1 className="app-title font-bold">Deleted-branch items</h1>
        <p className="text-muted-foreground text-sm">
          Work a Force Delete ended without resolving it. Nothing here was counted, clocked out,
          paid or written off on anyone’s behalf. Settle each one outside the app, then record how.
        </p>
      </div>
      <div className="flex gap-2" role="tablist">
        <Button
          type="button"
          role="tab"
          aria-selected={!reconciled}
          variant={reconciled ? 'outline' : 'default'}
          onClick={() => {
            setReconciled(false);
            setPage(1);
          }}
        >
          Unresolved
        </Button>
        <Button
          type="button"
          role="tab"
          aria-selected={reconciled}
          variant={reconciled ? 'default' : 'outline'}
          onClick={() => {
            setReconciled(true);
            setPage(1);
          }}
        >
          Reconciled
        </Button>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : isError ? (
        <div className="space-y-2">
          <p className="text-destructive text-sm" role="alert">
            Could not load the items.
          </p>
          <Button type="button" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title={reconciled ? 'Nothing reconciled yet' : 'Nothing unresolved'}
          description="Items appear here after a Force Delete."
        />
      ) : (
        <ul className="space-y-2" data-testid="closure-items">
          {items.map((item) => (
            <li key={item.id} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">
                    {item.branch_name}{' '}
                    <span className="text-muted-foreground font-mono">({item.branch_code})</span> ·{' '}
                    {item.kind.replaceAll('_', ' ')}
                  </p>
                  <p className="text-muted-foreground">{item.reason}</p>
                  <p className="text-muted-foreground break-all font-mono text-xs">
                    {item.source_table} {item.source_id}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Recorded {formatDateTime(item.recorded_at)} by {item.recorded_by_name}
                    {item.reconciled_at &&
                      ` · reconciled ${formatDateTime(item.reconciled_at)} by ${item.reconciled_by_name ?? 'Unknown'}: ${item.reconciliation_note ?? ''}`}
                  </p>
                  <details className="text-xs">
                    <summary className="cursor-pointer">Recorded details</summary>
                    <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(item.snapshot, null, 2)}
                    </pre>
                  </details>
                </div>
                {!item.reconciled_at && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setSelected(item)}
                  >
                    Mark reconciled
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center gap-2 text-sm">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span>
            Page {page} of {Math.ceil(total / PAGE_SIZE)} ({total} items)
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page * PAGE_SIZE >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      {selected && <ReconcileDialog item={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ReconcileDialog({ item, onClose }: { item: BranchClosureItem; onClose: () => void }) {
  const reconcile = useReconcileClosureItem();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await reconcile.mutateAsync({ itemId: item.id, note });
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to save');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark as reconciled</DialogTitle>
          <DialogDescription>
            {item.branch_name} · {item.kind.replaceAll('_', ' ')}. This records who settled it and
            how. It can’t be changed afterwards.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reconcile-note">How was it settled?</Label>
          <Textarea
            id="reconcile-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
          />
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={note.trim().length < 5 || reconcile.isPending}
            onClick={() => void submit()}
          >
            {reconcile.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
