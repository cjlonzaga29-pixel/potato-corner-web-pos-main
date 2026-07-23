'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PriceOverrideResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import { useReviewPriceOverride } from '@/hooks/queries/use-price-overrides';

interface ReviewPriceOverrideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  override: PriceOverrideResponse;
}

export function ReviewPriceOverrideDialog({ open, onOpenChange, override }: ReviewPriceOverrideDialogProps) {
  const review = useReviewPriceOverride(override.id);
  const [notes, setNotes] = useState('');
  const notesTooShort = notes.trim().length > 0 && notes.trim().length < 20;
  const difference = override.requested_price - override.master_price;

  function handleOpenChange(next: boolean) {
    if (!next) setNotes('');
    onOpenChange(next);
  }

  async function handleReject() {
    if (notes.trim().length < 20) return;
    await review.mutateAsync({ action: 'reject', review_notes: notes.trim() });
    handleOpenChange(false);
  }

  async function handleApprove() {
    await review.mutateAsync({ action: 'approve', review_notes: notes.trim() || undefined });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Review Price Override</DialogTitle>
          <DialogDescription>
            {override.branch_name} — {override.product_name} ({override.variant_name})
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-3 gap-2 rounded-md border p-3">
            <div>
              <p className="text-xs text-muted-foreground">Master Price</p>
              <p className="font-medium">{formatCurrency(override.master_price)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Requested Price</p>
              <p className="font-medium">{formatCurrency(override.requested_price)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Difference</p>
              <p className={`font-medium ${difference >= 0 ? 'text-success' : 'text-destructive'}`}>
                {difference >= 0 ? '+' : ''}
                {formatCurrency(difference)}
              </p>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Requested by</p>
            <p className="font-medium">{override.requested_by_name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Reason</p>
            <p>{override.request_reason}</p>
          </div>

          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              Review notes {' '}
              <span className="italic">(required, min 20 characters, if rejecting)</span>
            </p>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Optional for approval, required for rejection" />
            {notesTooShort && <p className="mt-1 text-xs text-destructive">Notes must be at least 20 characters.</p>}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="destructive" disabled={review.isPending || notes.trim().length < 20} onClick={() => void handleReject()}>
            {review.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reject
          </Button>
          <Button type="button" disabled={review.isPending} onClick={() => void handleApprove()}>
            {review.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
