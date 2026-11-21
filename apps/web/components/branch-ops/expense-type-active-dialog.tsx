'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ExpenseTypeResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useSetExpenseTypeActive } from '@/hooks/queries/use-expense-types';
import { useRestoreFocus } from '@/hooks/use-restore-focus';

interface ExpenseTypeActiveDialogProps {
  type: ExpenseTypeResponse;
  onOpenChange: (open: boolean) => void;
}

/** POS-PERF-P60 — Deactivate or Reactivate a type. Neither touches a single expense. */
export function ExpenseTypeActiveDialog({ type, onOpenChange }: ExpenseTypeActiveDialogProps) {
  const restoreFocus = useRestoreFocus();
  const setActive = useSetExpenseTypeActive(type.id);
  const [error, setError] = useState<string | null>(null);
  const deactivating = type.is_active;

  async function handleConfirm() {
    setError(null);
    try {
      await setActive.mutateAsync({ isActive: !deactivating, expectedVersion: type.version });
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to change this expense type.');
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !setActive.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-md" onCloseAutoFocus={restoreFocus}>
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">{deactivating ? `Deactivate ${type.name}?` : `Reactivate ${type.name}?`}</DialogTitle>
          <DialogDescription>{deactivating ? 'New expenses can no longer use this type.' : 'New expenses can use this type again.'}</DialogDescription>
        </DialogHeader>
        {deactivating && (
          <p className="text-sm">
            {type.expense_count === 1 ? '1 recorded expense keeps' : `${type.expense_count} recorded expenses keep`} this type, and stay in every total and report.
          </p>
        )}
        {error && (
          <p className="text-sm font-medium text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={setActive.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleConfirm()} disabled={setActive.isPending} data-testid="expense-type-active-confirm">
            {setActive.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {deactivating ? 'Deactivate Type' : 'Reactivate Type'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
