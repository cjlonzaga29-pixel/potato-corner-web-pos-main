'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Loader2, Plus, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useBranchStore } from '@/stores/branch.store';
import { formatCurrency, formatDate } from '@/lib/utils';
import {
  useExpenses,
  useCreateExpense,
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
  const [category, setCategory] = useState<ExpenseCategory>('supplies');
  const [amount, setAmount] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [description, setDescription] = useState('');
  const [incurredAt, setIncurredAt] = useState(() => new Date().toISOString().slice(0, 10));

  async function handleCreate() {
    await createExpense.mutateAsync({
      branch_id: branchId,
      category,
      amount: Number(amount),
      vendor_name: vendorName || undefined,
      description: description || undefined,
      incurred_at: incurredAt,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Expense</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Category</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as ExpenseCategory)}>
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
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Date Incurred</Label>
              <Input type="date" value={incurredAt} onChange={(e) => setIncurredAt(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Vendor (optional)</Label>
            <Input value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Description (optional)</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!amount || Number(amount) <= 0 || createExpense.isPending}>
            {createExpense.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Expense
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const columns: ColumnDef<ExpenseRow>[] = [
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
];

export default function SupervisorExpensesPage() {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  useExpensesRealtimeSync();
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, isError, refetch } = useExpenses({ branch_id: activeBranchId ?? undefined, limit: 25 });

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
    </div>
  );
}
