'use client';

import { Suspense, useMemo, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import type { PaginationState } from '@tanstack/react-table';
import { Download, Receipt } from 'lucide-react';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { expenseDisplayName } from '@potato-corner/shared';
import { createExpenseColumns } from '@/components/admin/expense-columns';
import { ExpenseBreakdownCard } from '@/components/reports/expense-breakdown-card';
import { ExpenseFilterBar } from '@/components/admin/expense-filter-bar';
import { ViewExpenseReceiptDialog, type ExpenseReceiptProofData } from '@/components/shared/transactions/view-expense-receipt-dialog';
import { useExpenses, useExpensesRealtimeSync, type ExpenseCategory } from '@/hooks/queries/use-expenses';
import { useRequestExport } from '@/hooks/queries/use-reports';
import { useSelectedBranch } from '@/hooks/use-selected-branch';
import { formatCurrency } from '@/lib/utils';

const ALL_BRANCHES = 'all';
const DEFAULT_PAGE_SIZE = 25;

function ExpensesPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { selectedBranchId } = useSelectedBranch();
  useExpensesRealtimeSync();

  const branchIdParam = searchParams.get('branch_id');
  const branchId = branchIdParam ?? (selectedBranchId !== ALL_BRANCHES ? selectedBranchId : ALL_BRANCHES);
  const expenseTypeId = searchParams.get('expense_type_id');
  const category = searchParams.get('category');
  const dateFrom = searchParams.get('date_from') ?? '';
  const dateTo = searchParams.get('date_to') ?? '';
  const page = Number(searchParams.get('page') ?? '1') || 1;
  const pageSize = Number(searchParams.get('limit') ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE;

  const pagination: PaginationState = { pageIndex: Math.max(page - 1, 0), pageSize };

  function pushParams(updates: Record<string, string | null>, resetPage: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === 'all') params.delete(key);
      else params.set(key, value);
    }
    if (resetPage) params.set('page', '1');
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const filters = {
    branch_id: branchId === ALL_BRANCHES ? undefined : branchId,
    expense_type_id: expenseTypeId ?? undefined,
    category: expenseTypeId ? undefined : ((category ?? undefined) as ExpenseCategory | undefined),
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    page,
    limit: pageSize,
  };

  const { data, isLoading, isError, refetch } = useExpenses(filters);
  const rows = data?.expenses ?? [];

  const [selectedExpenseId, setSelectedExpenseId] = useState<string | null>(null);
  const expenseColumns = useMemo(() => createExpenseColumns((row) => setSelectedExpenseId(row.id)), []);
  const selectedExpense = rows.find((row) => row.id === selectedExpenseId) ?? null;
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

  const typeFilter = expenseTypeId ? `type:${expenseTypeId}` : category ? `legacy:${category}` : 'all';
  const hasActiveFilters = branchId !== ALL_BRANCHES || typeFilter !== 'all' || dateFrom !== '' || dateTo !== '';
  const requestExport = useRequestExport();

  function clearFilters() {
    router.push(pathname, { scroll: false });
  }

  // POS-PERF-P60 — built by the server over these filters: a browser-built file only held the page on screen.
  function handleExportCsv() {
    requestExport.mutate({
      report_type: 'EXPENSES',
      filters: {
        branch_id: filters.branch_id,
        date_from: filters.date_from,
        date_to: filters.date_to,
        expense_type_id: filters.expense_type_id,
        expense_category: filters.category,
        page: 1,
        limit: pageSize,
      },
      format: 'csv',
    });
  }

  return (
    <div className="app-section app-section-gap">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="app-title font-bold">Expenses</h1>
          <p className="text-sm text-muted-foreground">Branch operating expenses and receipts</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={rows.length === 0 || requestExport.isPending} className="w-full sm:w-auto">
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">Total</p>
          {/* While loading or after a failure there is no total: 0 would read as a real figure. */}
          <p className="app-kpi-value font-bold" data-testid="expense-ledger-total">{data ? formatCurrency(data.total_amount) : '—'}</p>
        </CardContent>
      </Card>

      <ExpenseBreakdownCard
        title="Expenses by Type"
        branchId={filters.branch_id}
        dateFrom={filters.date_from}
        dateTo={filters.date_to}
        ledgerPath={pathname}
      />

      <ExpenseFilterBar
        filters={{ branchId, typeFilter, dateFrom, dateTo }}
        onChange={(updates) => pushParams(updates, true)}
        onClear={clearFilters}
        hasActiveFilters={hasActiveFilters}
      />

      <DataTable
        columns={expenseColumns}
        data={rows}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={(next) =>
          pushParams({ page: String(next.pageIndex + 1), limit: String(next.pageSize) }, false)
        }
        rowCount={data?.total ?? 0}
        emptyState={
          hasActiveFilters ? (
            <EmptyState
              icon={Receipt}
              title="No expenses match the current filters"
              description="Try a different branch, type, or date range."
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Receipt}
              title="No expenses recorded"
              description="Expenses are submitted by branch supervisors and appear here automatically."
            />
          )
        }
      />

      <ViewExpenseReceiptDialog
        expense={selectedExpenseReceipt}
        onOpenChange={(o) => !o && setSelectedExpenseId(null)}
        onRetry={() => void refetch()}
      />
    </div>
  );
}

export default function ExpensesPage() {
  return (
    <Suspense fallback={<div>Loading expenses...</div>}>
      <ExpensesPageContent />
    </Suspense>
  );
}
