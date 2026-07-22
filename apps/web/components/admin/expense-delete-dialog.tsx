'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useDeleteExpense, type ExpenseRow } from '@/hooks/queries/use-expenses';

const CATEGORY_LABELS: Record<string, string> = {
  utilities: 'Utilities',
  supplies: 'Supplies',
  staff_meals: 'Staff Meals',
  miscellaneous: 'Miscellaneous',
};

const CONFIRM_TEXT = 'DELETE';

interface ExpenseDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense: ExpenseRow;
}

export function ExpenseDeleteDialog({ open, onOpenChange, expense }: ExpenseDeleteDialogProps) {
  const router = useRouter();
  const deleteExpense = useDeleteExpense(expense.id);
  const [confirmText, setConfirmText] = useState('');
  const canDelete = confirmText === CONFIRM_TEXT;

  function handleOpenChange(next: boolean) {
    if (!next) setConfirmText('');
    onOpenChange(next);
  }

  async function handleConfirm() {
    await deleteExpense.mutateAsync();
    handleOpenChange(false);
    router.push('/admin/expenses');
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            </div>
            <DialogTitle>Delete Expense</DialogTitle>
          </div>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogHeader>

        <div className="space-y-1 rounded-md border p-3 text-sm">
          <p className="font-medium">
            {CATEGORY_LABELS[expense.category] ?? expense.category} — {formatCurrency(expense.amount)}
          </p>
          <p className="text-muted-foreground">{expense.branch_name}</p>
          <p className="text-muted-foreground">{formatDate(expense.incurred_at)}</p>
          {expense.vendor_name && <p className="text-muted-foreground">{expense.vendor_name}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="expense-delete-confirm">
            Type <span className="font-semibold">{CONFIRM_TEXT}</span> to confirm
          </Label>
          <Input
            id="expense-delete-confirm"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            placeholder={CONFIRM_TEXT}
            disabled={deleteExpense.isPending}
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={deleteExpense.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={!canDelete || deleteExpense.isPending}
            onClick={() => void handleConfirm()}
          >
            {deleteExpense.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
