'use client';

import { Suspense } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import type { PaginationState } from '@tanstack/react-table';
import { Download, ShieldAlert } from 'lucide-react';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { createDiscountAuditColumns } from '@/components/admin/discount-audit-columns';
import { DiscountAuditFilterBar } from '@/components/admin/discount-audit-filter-bar';
import { useDiscountAudit, type DiscountAuditType } from '@/hooks/queries/use-discount-audit';
import { useBranches } from '@/hooks/queries/use-branches';
import { downloadCsv } from '@/lib/utils';

const ALL_BRANCHES = 'all';
const ALL_DISCOUNT_TYPES = 'all';
const DEFAULT_PAGE_SIZE = 25;

function DiscountAuditPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const branchId = searchParams.get('branch_id') ?? ALL_BRANCHES;
  const discountType = searchParams.get('discount_type') ?? ALL_DISCOUNT_TYPES;
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
    discount_type: discountType === ALL_DISCOUNT_TYPES ? undefined : (discountType as DiscountAuditType),
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    page,
    limit: pageSize,
  };

  const { data, isLoading, isError, refetch } = useDiscountAudit(filters);
  const { data: branchesData } = useBranches({ limit: 100 });
  const branchNameById = new Map((branchesData?.branches ?? []).map((b) => [b.id, b.name]));

  const columns = createDiscountAuditColumns(branchNameById);
  const rows = data?.data ?? [];

  const hasActiveFilters = branchId !== ALL_BRANCHES || discountType !== ALL_DISCOUNT_TYPES || dateFrom !== '' || dateTo !== '';

  function clearFilters() {
    router.push(pathname, { scroll: false });
  }

  function handleExportCsv() {
    downloadCsv(
      `discount-audit-${new Date().toISOString().slice(0, 10)}.csv`,
      rows.map((row) => ({
        transaction_number: row.transactionNumber,
        branch: branchNameById.get(row.branchId) ?? row.branchId,
        discount_type: row.discountType,
        discount_amount: row.discountAmount,
        discount_customer_id: row.discountCustomerId ?? (row.discountCustomerIdEncrypted ? '****' : ''),
        fraud_flagged: row.fraudFlagged ? 'yes' : 'no',
        created_at: row.createdAt,
      })),
      [
        { key: 'transaction_number', label: 'Receipt #' },
        { key: 'branch', label: 'Branch' },
        { key: 'discount_type', label: 'Discount Type' },
        { key: 'discount_amount', label: 'Discount Amount' },
        { key: 'discount_customer_id', label: 'Customer ID' },
        { key: 'fraud_flagged', label: 'Fraud Flagged' },
        { key: 'created_at', label: 'Date' },
      ],
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Discount Audit</h1>
          <p className="text-sm text-muted-foreground">Cross-branch discount trail with fraud-flag correlation</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={rows.length === 0}>
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      <DiscountAuditFilterBar
        filters={{ branchId, discountType, dateFrom, dateTo }}
        onChange={(updates) => pushParams(updates, true)}
      />

      <DataTable
        columns={columns}
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
              icon={ShieldAlert}
              title="No discounts match the current filters"
              description="Try a different branch, discount type, or date range."
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState icon={ShieldAlert} title="No discounted transactions found" description="No discounts have been recorded yet." />
          )
        }
      />
    </div>
  );
}

export default function DiscountAuditPage() {
  return (
    <Suspense fallback={<div>Loading discount audit...</div>}>
      <DiscountAuditPageContent />
    </Suspense>
  );
}
