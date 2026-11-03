'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Download, Pencil, Plus, Power, Receipt, Tags } from 'lucide-react';
import { ROLES, expenseDisplayName, type ExpenseTypeResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ViewExpenseReceiptDialog, type ExpenseReceiptProofData } from '@/components/shared/transactions/view-expense-receipt-dialog';
import { CreateExpenseDialog } from '@/components/branch-ops/create-expense-dialog';
import { ExpenseTypeActiveDialog } from '@/components/branch-ops/expense-type-active-dialog';
import { ExpenseTypeBoard, type ExpenseLedgerView } from '@/components/branch-ops/expense-type-board';
import { ExpenseTypeFormDialog } from '@/components/branch-ops/expense-type-form-dialog';
import { useBranchStore } from '@/stores/branch.store';
import { useAuthStore } from '@/stores/auth.store';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useExpenseTypes } from '@/hooks/queries/use-expense-types';
import { useExpenses, useExpenseSummary, useExpensesRealtimeSync, type ExpenseFilters, type ExpenseRow } from '@/hooks/queries/use-expenses';
import { useRequestExport } from '@/hooks/queries/use-reports';

const PAGE_SIZE = 25;

function createColumns(onViewReceipt: (expense: ExpenseRow) => void): ColumnDef<ExpenseRow>[] {
  return [
    { id: 'incurred_at', header: 'Date', cell: ({ row }) => formatDate(row.original.incurred_at) },
    {
      id: 'expense_type',
      header: 'Type',
      cell: ({ row }) => {
        const { expense_type_id: typeId, expense_type_name: recorded, expense_type_current_name: current } = row.original;
        return (
          <span className="block min-w-24 [overflow-wrap:anywhere]">
            {expenseDisplayName(row.original)}
            {typeId && current && current !== recorded && <span className="block text-xs text-muted-foreground">now called {current}</span>}
          </span>
        );
      },
    },
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

function viewFilters(view: ExpenseLedgerView): Pick<ExpenseFilters, 'expense_type_id' | 'category' | 'unassigned'> {
  if (view.kind === 'type') return { expense_type_id: view.id };
  if (view.kind === 'legacy') return view.category ? { category: view.category as ExpenseFilters['category'] } : { unassigned: true };
  return {};
}

interface ExpensesLedgerProps {
  branchId: string;
  initialView: ExpenseLedgerView;
  initialDateFrom: string;
  initialDateTo: string;
}

/**
 * Keyed by branch below: switching branches starts this over, so no filter, open
 * dialog or row from the last branch ever shows under the new one.
 */
function ExpensesLedger({ branchId, initialView, initialDateFrom, initialDateTo }: ExpensesLedgerProps) {
  useExpensesRealtimeSync();
  const canManageTypes = useAuthStore((s) => s.user?.role === ROLES.SUPERVISOR);
  const [view, setView] = useState<ExpenseLedgerView>(initialView);
  const [dateFrom, setDateFrom] = useState(initialDateFrom);
  const [dateTo, setDateTo] = useState(initialDateTo);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [typeForm, setTypeForm] = useState<{ type: ExpenseTypeResponse | null } | null>(null);
  const [activeDialogType, setActiveDialogType] = useState<ExpenseTypeResponse | null>(null);
  const [selectedExpenseId, setSelectedExpenseId] = useState<string | null>(null);

  const dates = { date_from: dateFrom || undefined, date_to: dateTo || undefined };
  const typeList = useExpenseTypes({ branchId, includeInactive: true });
  const summary = useExpenseSummary({ branch_id: branchId, ...dates });
  const { data, isLoading, isError, refetch } = useExpenses({ branch_id: branchId, ...dates, ...viewFilters(view), page, limit: PAGE_SIZE });
  const requestExport = useRequestExport();
  const columns = useMemo(() => createColumns((row) => setSelectedExpenseId(row.id)), []);

  const types = typeList.data ?? [];
  const selectedType = view.kind === 'type' ? types.find((type) => type.id === view.id) : undefined;
  const viewGroup = view.kind === 'type' ? summary.data?.groups.find((group) => group.expense_type_id === view.id) : undefined;
  const viewName = view.kind === 'all' ? 'All Expenses' : view.kind === 'legacy' ? 'Legacy / Unassigned' : (selectedType?.name ?? viewGroup?.name ?? 'Expense type');
  const viewDeactivated = selectedType ? !selectedType.is_active : viewGroup?.is_active === false;

  const expenses = data?.expenses ?? [];
  const selectedExpense = expenses.find((row) => row.id === selectedExpenseId) ?? null;
  const selectedExpenseReceipt: ExpenseReceiptProofData | null =
    selectedExpense && selectedExpense.receipt_url
      ? {
          id: selectedExpense.id,
          receiptUrl: selectedExpense.receipt_url,
          branchName: selectedExpense.branch_name,
          categoryLabel: expenseDisplayName(selectedExpense),
          vendorName: selectedExpense.vendor_name,
          amount: selectedExpense.amount,
          incurredAt: selectedExpense.incurred_at,
          createdByName: selectedExpense.created_by_name,
        }
      : null;

  const pagination: PaginationState = { pageIndex: page - 1, pageSize: PAGE_SIZE };

  function selectView(next: ExpenseLedgerView) {
    setView(next);
    setPage(1);
    setSelectedExpenseId(null);
  }

  function handleExport(format: 'csv' | 'pdf') {
    const filters = viewFilters(view);
    requestExport.mutate({
      report_type: 'EXPENSES',
      filters: {
        branch_id: branchId,
        ...dates,
        expense_type_id: filters.expense_type_id,
        expense_category: filters.category,
        expense_unassigned: filters.unassigned,
        page: 1,
        limit: PAGE_SIZE,
      },
      format,
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Expenses</h1>
          <p className="text-sm text-muted-foreground">Branch expense ledger.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManageTypes && (
            <Button size="sm" variant="outline" onClick={() => setTypeForm({ type: null })}>
              <Tags className="mr-2 h-4 w-4" />
              Create Expense Type
            </Button>
          )}
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Expense
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="ledger-date-from">From</Label>
          <Input
            id="ledger-date-from"
            type="date"
            className="w-[160px]"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ledger-date-to">To</Label>
          <Input
            id="ledger-date-to"
            type="date"
            className="w-[160px]"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {(dateFrom || dateTo) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDateFrom('');
              setDateTo('');
              setPage(1);
            }}
          >
            All dates
          </Button>
        )}
      </div>

      {typeList.isError && (
        <Alert variant="destructive" className="px-3 py-2" data-testid="expense-types-error">
          <AlertDescription>
            Expense types could not be loaded, so their cards may be missing. All Expenses below is still complete.{' '}
            <button type="button" className="underline underline-offset-2" onClick={() => void typeList.refetch()}>
              Try again
            </button>
          </AlertDescription>
        </Alert>
      )}
      {summary.isError && (
        <Alert variant="destructive" className="px-3 py-2" data-testid="expense-summary-error">
          <AlertDescription>
            Totals by type are unavailable.{' '}
            <button type="button" className="underline underline-offset-2" onClick={() => void summary.refetch()}>
              Try again
            </button>
          </AlertDescription>
        </Alert>
      )}

      <ExpenseTypeBoard types={types} summary={summary.data} view={view} onSelect={selectView} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between" data-testid="expense-view-header">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold [overflow-wrap:anywhere]">
            {viewName}
            {viewDeactivated && <Badge variant="inactive">Deactivated</Badge>}
          </h2>
          {selectedType?.description && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{selectedType.description}</p>}
          {viewDeactivated && <p className="text-sm text-muted-foreground">New expenses can&apos;t use this type. Its records stay here and in every total.</p>}
          {view.kind === 'legacy' && <p className="text-sm text-muted-foreground">Recorded before expense types, under their original categories.</p>}
          <p className="mt-1 text-sm text-muted-foreground" data-testid="expense-view-total">
            {isError || !data ? (
              isLoading ? 'Loading total…' : 'Total unavailable'
            ) : (
              <>
                Total: <span className="font-medium text-foreground">{formatCurrency(data.total_amount)}</span> across {data.total} {data.total === 1 ? 'record' : 'records'}
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {selectedType?.can_manage && (
            <>
              <Button size="sm" variant="outline" onClick={() => setTypeForm({ type: selectedType })}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit Type
              </Button>
              <Button size="sm" variant="outline" onClick={() => setActiveDialogType(selectedType)}>
                <Power className="mr-2 h-4 w-4" />
                {selectedType.is_active ? 'Deactivate' : 'Reactivate'}
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" onClick={() => handleExport('csv')} disabled={requestExport.isPending || !data?.total}>
            <Download className="mr-2 h-4 w-4" />
            CSV
          </Button>
          <Button size="sm" variant="outline" onClick={() => handleExport('pdf')} disabled={requestExport.isPending || !data?.total}>
            <Download className="mr-2 h-4 w-4" />
            PDF
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={expenses}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={(next) => setPage(next.pageIndex + 1)}
        rowCount={data?.total ?? 0}
        getRowId={(row) => row.id}
        emptyState={
          <EmptyState
            icon={Receipt}
            title={view.kind === 'all' ? 'No expenses yet' : 'No expenses of this type'}
            description={dateFrom || dateTo ? 'Nothing was recorded in this date range.' : 'Expenses recorded for this branch will appear here.'}
          />
        }
      />

      {createOpen && (
        <CreateExpenseDialog
          branchId={branchId}
          preselectedTypeId={view.kind === 'type' ? view.id : null}
          canManageTypes={canManageTypes}
          onCreateType={() => {
            setCreateOpen(false);
            setTypeForm({ type: null });
          }}
          onOpenChange={setCreateOpen}
        />
      )}

      {typeForm && (
        <ExpenseTypeFormDialog
          type={typeForm.type}
          defaultBranchId={branchId}
          onOpenChange={(open) => !open && setTypeForm(null)}
          onSaved={(saved) => {
            setTypeForm(null);
            if (saved.branches.some((branch) => branch.branch_id === branchId)) selectView({ kind: 'type', id: saved.id });
          }}
        />
      )}

      {activeDialogType && <ExpenseTypeActiveDialog type={activeDialogType} onOpenChange={(open) => !open && setActiveDialogType(null)} />}

      <ViewExpenseReceiptDialog
        expense={selectedExpenseReceipt}
        onOpenChange={(o) => !o && setSelectedExpenseId(null)}
        onRetry={() => void refetch()}
      />
    </div>
  );
}

/** Shared body behind both `/supervisor/expenses` and `/branch/expenses`. */
export function ExpensesView() {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const searchParams = useSearchParams();

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

  // A drill-through link's filters apply only to the branch they were made for.
  const linkBranch = searchParams.get('branch_id');
  const linkApplies = !linkBranch || linkBranch === activeBranchId;
  const linkedType = linkApplies ? searchParams.get('expense_type_id') : null;
  const linkedCategory = linkApplies ? searchParams.get('category') : null;
  const initialView: ExpenseLedgerView = linkedType ? { kind: 'type', id: linkedType } : linkedCategory ? { kind: 'legacy', category: linkedCategory } : { kind: 'all' };

  return (
    <ExpensesLedger
      key={activeBranchId}
      branchId={activeBranchId}
      initialView={initialView}
      initialDateFrom={(linkApplies && searchParams.get('date_from')) || ''}
      initialDateTo={(linkApplies && searchParams.get('date_to')) || ''}
    />
  );
}
