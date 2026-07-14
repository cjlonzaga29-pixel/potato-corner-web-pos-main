'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ShiftResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import { useApproveVariance } from '@/hooks/queries/use-shifts';

const MIN_NOTES_LENGTH = 50;

interface ReviewVarianceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shift: ShiftResponse;
}

/** Notes are required (>= 50 chars) for both approve and reject here — unlike price-override review, approveVarianceSchema has no "optional for approval" carve-out. */
export function ReviewVarianceDialog({ open, onOpenChange, shift }: ReviewVarianceDialogProps) {
  const approveVariance = useApproveVariance(shift.id);
  const [notes, setNotes] = useState('');
  const notesTooShort = notes.trim().length < MIN_NOTES_LENGTH;

  function handleOpenChange(next: boolean) {
    if (!next) setNotes('');
    onOpenChange(next);
  }

  async function handleDecision(approved: boolean) {
    if (notesTooShort) return;
    await approveVariance.mutateAsync({ approved, notes: notes.trim() });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Review Cash Variance</DialogTitle>
          <DialogDescription>Shift {shift.id.slice(0, 8)} — variance {formatCurrency(shift.cash_variance ?? 0)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Cashier's explanation</p>
            <p>{shift.variance_explanation ?? '—'}</p>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              Your written justification <span className="italic">(required, min {MIN_NOTES_LENGTH} characters)</span>
            </p>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Explain your approve/reject decision" />
            <p className="mt-1 text-xs text-muted-foreground">{notes.trim().length}/{MIN_NOTES_LENGTH}</p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="destructive" disabled={approveVariance.isPending || notesTooShort} onClick={() => void handleDecision(false)}>
            {approveVariance.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reject
          </Button>
          <Button type="button" disabled={approveVariance.isPending || notesTooShort} onClick={() => void handleDecision(true)}>
            {approveVariance.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
