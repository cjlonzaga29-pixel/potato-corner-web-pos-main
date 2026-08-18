'use client';

import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Loader2, Plus, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ImageUpload } from '@/components/shared/forms/image-upload';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ViewExpenseReceiptDialog, type ExpenseReceiptProofData } from '@/components/shared/transactions/view-expense-receipt-dialog';
import { useBranchStore } from '@/stores/branch.store';
import { formatCurrency, formatDate } from '@/lib/utils';
import { manilaToday } from '@/lib/manila-date';
import {
  useExpenses,
  useCreateExpense,
  useUploadExpenseReceiptForExpense,
  useExpensesRealtimeSync,
  type ExpenseCategory,
  type ExpenseRow,
} from '@/hooks/queries/use-expenses';

const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  utilities: 'Utilities',
  supplies: 'Supplies',
  staff_meals: 'Staff Meals',
  miscellaneous: 'Miscellaneous',
};

function CreateExpenseDialog({ branchId, onOpenChange }: { branchId: string; onOpenChange: (open: boolean) => void }) {
  const createExpense = useCreateExpense();
  const uploadReceipt = useUploadExpenseReceiptForExpense();
  const [category, setCategory] = useState<ExpenseCategory>('supplies');
  const [amount, setAmount] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [description, setDescription] = useState('');
  const [incurredAt, setIncurredAt] = useState(() => manilaToday());

  // Task: expense receipt upload — a receipt needs an expense id, which
  // doesn't exist until createExpense resolves. handleCreate stages the
  // create first, then uploads the receipt as a second, isolated step.
  // createdExpenseId only becomes non-null if that second step fails, so the
  // dialog can stay open and retry the upload (same expense id) without ever
  // re-creating the expense — same shape as CreateProductDialog (Task 209.6).
  const [pendingReceipt, setPendingReceipt] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [createdExpenseId, setCreatedExpenseId] = useState<string | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  function handleReceiptStaged(file: File) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingReceipt(file);
    setPreviewUrl(URL.createObjectURL(file));
    setReceiptError(null);
  }

  function handleReceiptRemove() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingReceipt(null);
    setPreviewUrl(null);
    setReceiptError(null);
  }

  async function handleCreate() {
    let expenseId = createdExpenseId;

    if (!expenseId) {
      const created = await createExpense.mutateAsync({
        branch_id: branchId,
        category,
        amount: Number(amount),
        vendor_name: vendorName || undefined,
        description: description || undefined,
        incurred_at: incurredAt,
      });
      expenseId = created.id;
      setCreatedExpenseId(created.id);
    }

    if (pendingReceipt) {
      try {
        await uploadReceipt.mutateAsync({ expenseId, file: pendingReceipt });
      } catch (error) {
        // The expense itself is already recorded — only the receipt step
        // failed. Keep the dialog open (createdExpenseId is now set) so
        // retrying re-uses this same expense instead of creating another.
        setReceiptError(error instanceof Error ? error.message : 'Receipt upload failed — try again.');
        return;
      }
    }

    onOpenChange(false);
  }

  function handleContinueWithoutPhoto() {
    onOpenChange(false);
  }

  const isRetryingReceipt = Boolean(createdExpenseId) && Boolean(receiptError);
  const isSubmitting = createExpense.isPending || uploadReceipt.isPending;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Expense</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Category</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as ExpenseCategory)} disabled={Boolean(createdExpenseId)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Amount</Label>
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={Boolean(createdExpenseId)} />
            </div>
            <div className="space-y-1">
              <Label>Date Incurred</Label>
              <Input type="date" value={incurredAt} onChange={(e) => setIncurredAt(e.target.value)} disabled={Boolean(createdExpenseId)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Vendor (optional)</Label>
            <Input value={vendorName} onChange={(e) => setVendorName(e.target.value)} disabled={Boolean(createdExpenseId)} />
          </div>
          <div className="space-y-1">
            <Label>Description (optional)</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} disabled={Boolean(createdExpenseId)} />
          </div>

          {!isRetryingReceipt && (
            <div className="space-y-2">
              {!pendingReceipt ? (
                <ImageUpload
                  label="Receipt / Expense Proof"
                  description="Optional — JPEG, PNG, or WebP, up to 5MB."
                  onImageSelected={handleReceiptStaged}
                />
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Receipt / Expense Proof</p>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview of a not-yet-uploaded file */}
                  {previewUrl && <img src={previewUrl} alt="Receipt preview" className="max-h-[200px] w-full rounded-md border object-contain" />}
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={handleReceiptRemove} disabled={isSubmitting}>
                      Replace
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={handleReceiptRemove} disabled={isSubmitting}>
                      Remove
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {isRetryingReceipt && (
            <Alert variant="destructive" className="px-3 py-2">
              <AlertDescription>
                Expense was recorded, but the receipt photo could not be uploaded.
                {receiptError ? ` (${receiptError})` : ''}
              </AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          {isRetryingReceipt ? (
            <Button variant="outline" onClick={handleContinueWithoutPhoto}>
              Continue Without Photo
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={Boolean(createdExpenseId)}>
              Cancel
            </Button>
          )}
          <Button
            onClick={() => void handleCreate()}
            disabled={(!createdExpenseId && (!amount || Number(amount) <= 0)) || isSubmitting}
          >
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isRetryingReceipt ? 'Retry Photo Upload' : 'Save Expense'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function createColumns(onViewReceipt: (expense: ExpenseRow) => void): ColumnDef<ExpenseRow>[] {
  return [
    { id: 'incurred_at', header: 'Date', cell: ({ row }) => formatDate(row.original.incurred_at) },
    { id: 'category', header: 'Category', cell: ({ row }) => CATEGORY_LABEL[row.original.category] },
    { id: 'vendor_name', header: 'Vendor', cell: ({ row }) => row.original.vendor_name ?? '—' },
    {
      id: 'description',
      header: 'Description',
      cell: ({ row }) => <span className="line-clamp-1 max-w-xs text-muted-foreground">{row.original.description ?? '—'}</span>,
    },
    { id: 'amount', header: 'Amount', cell: ({ row }) => formatCurrency(row.original.amount) },
    { id: 'created_by_name', header: 'Recorded By', cell: ({ row }) => row.original.created_by_name },
    {
      id: 'proof',
      header: 'Proof',
      cell: ({ row }) =>
        row.original.receipt_url ? (
          <button
            type="button"
            onClick={() => onViewReceipt(row.original)}
            className="text-primary underline underline-offset-2 hover:no-underline"
          >
            View Proof
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">No Proof</span>
        ),
    },
  ];
}

/** Shared body behind both `/supervisor/expenses` and `/branch/expenses`. */
export function ExpensesView() {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  useExpensesRealtimeSync();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedExpenseId, setSelectedExpenseId] = useState<string | null>(null);
  const { data, isLoading, isError, refetch } = useExpenses({ branch_id: activeBranchId ?? undefined, limit: 25 });
  const columns = useMemo(() => createColumns((row) => setSelectedExpenseId(row.id)), []);

  if (!activeBranchId) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Expenses</h1>
          <p className="text-sm text-muted-foreground">Track branch expenses.</p>
        </div>
        <EmptyState title="No branch selected" description="Select an active branch to view expenses." />
      </div>
    );
  }

  const expenses = data?.expenses ?? [];
  const selectedExpense = expenses.find((row) => row.id === selectedExpenseId) ?? null;
  const selectedExpenseReceipt: ExpenseReceiptProofData | null =
    selectedExpense && selectedExpense.receipt_url
      ? {
          id: selectedExpense.id,
          receiptUrl: selectedExpense.receipt_url,
          branchName: selectedExpense.branch_name,
          categoryLabel: CATEGORY_LABEL[selectedExpense.category],
          vendorName: selectedExpense.vendor_name,
          amount: selectedExpense.amount,
          incurredAt: selectedExpense.incurred_at,
          createdByName: selectedExpense.created_by_name,
        }
      : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Expenses</h1>
          <p className="text-sm text-muted-foreground">Branch expense ledger.</p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Expense
        </Button>
      </div>

      {expenses.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Total: <span className="font-medium text-foreground">{formatCurrency(data?.total_amount ?? 0)}</span>
        </p>
      )}

      <DataTable
        columns={columns}
        data={expenses}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={
          <EmptyState icon={Receipt} title="No expenses yet" description="Expenses recorded for this branch will appear here." />
        }
      />

      {createOpen && <CreateExpenseDialog branchId={activeBranchId} onOpenChange={setCreateOpen} />}

      <ViewExpenseReceiptDialog
        expense={selectedExpenseReceipt}
        onOpenChange={(o) => !o && setSelectedExpenseId(null)}
        onRetry={() => void refetch()}
      />
    </div>
  );
}
