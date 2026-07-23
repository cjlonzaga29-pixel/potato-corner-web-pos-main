'use client';

import { Suspense } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { PaginationState } from '@tanstack/react-table';
import { Download, Plus, Receipt } from 'lucide-react';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { expenseColumns } from '@/components/admin/expense-columns';
import { ExpenseFilterBar } from '@/components/admin/expense-filter-bar';
import { useExpenses, useExpensesRealtimeSync, type ExpenseCategory } from '@/hooks/queries/use-expenses';
import { useSelectedBranch } from '@/hooks/use-selected-branch';
import { downloadCsv, formatCurrency } from '@/lib/utils';

const ALL_BRANCHES = 'all';
const ALL_CATEGORIES = 'all';
const DEFAULT_PAGE_SIZE = 25;

function ExpensesPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { selectedBranchId } = useSelectedBranch();
  useExpensesRealtimeSync();

  const branchIdParam = searchParams.get('branch_id');
  const branchId = branchIdParam ?? (selectedBranchId !== ALL_BRANCHES ? selectedBranchId : ALL_BRANCHES);
  const category = searchParams.get('category') ?? ALL_CATEGORIES;
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
    category: category === ALL_CATEGORIES ? undefined : (category as ExpenseCategory),
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    page,
    limit: pageSize,
  };

  const { data, isLoading, isError, refetch } = useExpenses(filters);
  const rows = data?.expenses ?? [];

  const hasActiveFilters = branchId !== ALL_BRANCHES || category !== ALL_CATEGORIES || dateFrom !== '' || dateTo !== '';

  function clearFilters() {
    router.push(pathname, { scroll: false });
  }

  function handleExportCsv() {
    downloadCsv(
      `expenses-${new Date().toISOString().slice(0, 10)}.csv`,
      rows.map((row) => ({
        incurred_at: row.incurred_at,
        branch: row.branch_name,
        category: row.category,
        vendor_name: row.vendor_name ?? '',
        amount: row.amount,
        created_by_name: row.created_by_name,
      })),
      [
        { key: 'incurred_at', label: 'Date' },
        { key: 'branch', label: 'Branch' },
        { key: 'category', label: 'Category' },
        { key: 'vendor_name', label: 'Vendor' },
        { key: 'amount', label: 'Amount' },
        { key: 'created_by_name', label: 'Recorded By' },
      ],
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Expenses</h1>
          <p className="text-sm text-muted-foreground">Branch operating expenses and receipts</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={rows.length === 0}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button size="sm" asChild>
            <Link href="/admin/expenses/new">
              <Plus className="mr-2 h-4 w-4" />
              Create Expense
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">Total</p>
          <p className="text-2xl font-bold">{formatCurrency(data?.total_amount ?? 0)}</p>
        </CardContent>
      </Card>

      <ExpenseFilterBar
        filters={{ branchId, category, dateFrom, dateTo }}
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
              description="Try a different branch, category, or date range."
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState icon={Receipt} title="No expenses recorded" description="No expenses have been recorded yet." />
          )
        }
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
