'use client';

import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useBranchStore } from '@/stores/branch.store';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useExpenses, useCreateExpense, useExpensesRealtimeSync, type ExpenseCategory } from '@/hooks/queries/use-expenses';

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

export default function SupervisorExpensesPage() {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  useExpensesRealtimeSync();
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, isError } = useExpenses({ branch_id: activeBranchId ?? undefined, limit: 25 });

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

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {isError && <EmptyState title="Failed to load expenses" description="Please try again." />}
      {!isLoading && !isError && expenses.length === 0 && (
        <EmptyState title="No expenses yet" description="Expenses recorded for this branch will appear here." />
      )}

      {!isLoading && !isError && expenses.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">
            Total: <span className="font-medium text-foreground">{formatCurrency(data?.total_amount ?? 0)}</span>
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Recorded By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expenses.map((expense) => (
                <TableRow key={expense.id}>
                  <TableCell>{formatDate(expense.incurred_at)}</TableCell>
                  <TableCell>{CATEGORY_LABEL[expense.category]}</TableCell>
                  <TableCell>{expense.vendor_name ?? '—'}</TableCell>
                  <TableCell className="max-w-xs">
                    <span className="line-clamp-1 text-muted-foreground">{expense.description ?? '—'}</span>
                  </TableCell>
                  <TableCell>{formatCurrency(expense.amount)}</TableCell>
                  <TableCell>{expense.created_by_name}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}

      {createOpen && <CreateExpenseDialog branchId={activeBranchId} onOpenChange={setCreateOpen} />}
    </div>
  );
}
