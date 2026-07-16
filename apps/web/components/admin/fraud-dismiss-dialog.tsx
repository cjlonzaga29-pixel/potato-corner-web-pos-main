'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import type { FraudAlertResponse } from '@potato-corner/shared';
import { useDismissAlert } from '@/hooks/queries/use-fraud-alerts';

const MIN_REASON_LENGTH = 10;

interface DismissFraudAlertDialogProps {
  alert: FraudAlertResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Pure UI + mutation — no data fetching. The alert list itself lives on the fraud-alerts page. */
export function DismissFraudAlertDialog({ alert, open, onOpenChange }: DismissFraudAlertDialogProps) {
  const [reason, setReason] = useState('');
  const dismissAlert = useDismissAlert();

  function resetAndClose() {
    setReason('');
    onOpenChange(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setReason('');
    }
    onOpenChange(nextOpen);
  }

  function handleSubmit() {
    if (!alert || reason.trim().length < MIN_REASON_LENGTH) return;
    dismissAlert.mutate(
      { id: alert.id, input: { dismissal_reason: reason } },
      { onSuccess: resetAndClose },
    );
  }

  const canSubmit = reason.length >= MIN_REASON_LENGTH && !dismissAlert.isPending;

  return (
    <Dialog open={open} onOpenChange={dismissAlert.isPending ? undefined : handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dismiss Fraud Alert</DialogTitle>
          <DialogDescription>
            {alert ? `Explain why "${alert.alert_type}" is being dismissed. This is recorded on the alert.` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="dismissal-reason">Dismissal Reason (required, min 10 characters)</Label>
          <Textarea
            id="dismissal-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Verified with branch supervisor — discrepancy was a legitimate manual price adjustment."
            disabled={dismissAlert.isPending}
            rows={4}
          />
          <p className="text-xs text-muted-foreground">
            {reason.length} / {MIN_REASON_LENGTH} minimum
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={resetAndClose} disabled={dismissAlert.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleSubmit} disabled={!canSubmit}>
            {dismissAlert.isPending ? <LoadingSpinner size="sm" className="text-current" /> : 'Dismiss Alert'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
