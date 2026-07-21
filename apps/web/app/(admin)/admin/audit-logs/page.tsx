'use client';

import { Suspense } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import type { PaginationState } from '@tanstack/react-table';
import { FileSearch } from 'lucide-react';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Button } from '@/components/ui/button';
import { createAuditLogColumns } from '@/components/admin/audit-log-columns';
import { AuditLogFilterBar } from '@/components/admin/audit-log-filter-bar';
import { useAuditLogs } from '@/hooks/queries/use-audit-logs';

const ALL_BRANCHES = 'all';
const DEFAULT_PAGE_SIZE = 25;

const columns = createAuditLogColumns();

function AuditLogsPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const branchId = searchParams.get('branch_id') ?? ALL_BRANCHES;
  const dateFrom = searchParams.get('date_from') ?? '';
  const dateTo = searchParams.get('date_to') ?? '';
  const action = searchParams.get('action') ?? '';
  const entityType = searchParams.get('entity_type') ?? '';
  const page = Number(searchParams.get('page') ?? '1') || 1;
  const pageSize = Number(searchParams.get('limit') ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE;

  const pagination: PaginationState = { pageIndex: Math.max(page - 1, 0), pageSize };

  /** Pushes URL param updates (shallow, no scroll jump) — the URL is the single source of truth for every filter and the pagination state. */
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

  const { data, isLoading, isError, refetch } = useAuditLogs({
    branch_id: branchId === ALL_BRANCHES ? undefined : branchId,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    action: action || undefined,
    entity_type: entityType || undefined,
    page,
    limit: pageSize,
  });

  const logs = data?.logs ?? [];

  const hasActiveFilters =
    branchId !== ALL_BRANCHES || dateFrom !== '' || dateTo !== '' || action !== '' || entityType !== '';

  function clearFilters() {
    router.push(pathname, { scroll: false });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Audit Logs</h1>
        <p className="text-sm text-muted-foreground">Review system activity and record changes</p>
      </div>

      <AuditLogFilterBar
        filters={{ branchId, dateFrom, dateTo, action, entityType }}
        onChange={(updates) => pushParams(updates, true)}
      />

      <DataTable
        columns={columns}
        data={logs}
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
              icon={FileSearch}
              title="No audit logs match the current filters"
              description="Try a different branch, date range, action, or entity type."
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState icon={FileSearch} title="No audit logs found" description="No system activity has been recorded yet." />
          )
        }
      />
    </div>
  );
}

export default function AuditLogsPage() {
  return (
    <Suspense fallback={<div>Loading audit logs...</div>}>
      <AuditLogsPageContent />
    </Suspense>
  );
}
