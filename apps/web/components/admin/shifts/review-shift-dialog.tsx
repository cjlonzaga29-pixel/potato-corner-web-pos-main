'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ShiftReviewPhase } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useReviewShift } from '@/hooks/queries/use-shifts';

const MIN_NOTES_LENGTH = 50;

interface ReviewShiftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shiftId: string;
  phase: ShiftReviewPhase;
}

/** Opening/Closing shift review — separate approval flow from ReviewVarianceDialog's cash-variance review. Same 50-char written-justification requirement for both approve and reject. */
export function ReviewShiftDialog({ open, onOpenChange, shiftId, phase }: ReviewShiftDialogProps) {
  const reviewShift = useReviewShift(shiftId, phase);
  const [notes, setNotes] = useState('');
  const notesTooShort = notes.trim().length < MIN_NOTES_LENGTH;

  function handleOpenChange(next: boolean) {
    if (!next) setNotes('');
    onOpenChange(next);
  }

  async function handleDecision(approved: boolean) {
    if (notesTooShort) return;
    await reviewShift.mutateAsync({ approved, notes: notes.trim() });
    handleOpenChange(false);
  }

  const phaseLabel = phase === 'opening' ? 'Opening' : 'Closing';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Review {phaseLabel} Count</DialogTitle>
          <DialogDescription>Shift {shiftId.slice(0, 8)} — {phaseLabel.toLowerCase()} shift review</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              Your written justification <span className="italic">(required, min {MIN_NOTES_LENGTH} characters)</span>
            </p>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Explain your approve/reject decision" />
            <p className="mt-1 text-xs text-muted-foreground">{notes.trim().length}/{MIN_NOTES_LENGTH}</p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="destructive" disabled={reviewShift.isPending || notesTooShort} onClick={() => void handleDecision(false)}>
            {reviewShift.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reject
          </Button>
          <Button type="button" disabled={reviewShift.isPending || notesTooShort} onClick={() => void handleDecision(true)}>
            {reviewShift.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
