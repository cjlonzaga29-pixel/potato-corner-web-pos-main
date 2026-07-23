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

function AuditLogsPanelContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const branchId = searchParams.get('audit_branch_id') ?? ALL_BRANCHES;
  const dateFrom = searchParams.get('audit_date_from') ?? '';
  const dateTo = searchParams.get('audit_date_to') ?? '';
  const action = searchParams.get('audit_action') ?? '';
  const entityType = searchParams.get('audit_entity_type') ?? '';
  const page = Number(searchParams.get('audit_page') ?? '1') || 1;
  const pageSize = Number(searchParams.get('audit_limit') ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE;

  const pagination: PaginationState = { pageIndex: Math.max(page - 1, 0), pageSize };

  /** Namespaced with an `audit_` prefix so this panel's filters don't collide with the parent Reports page's own params. */
  function pushParams(updates: Record<string, string | null>, resetPage: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === 'all') params.delete(key);
      else params.set(key, value);
    }
    if (resetPage) params.set('audit_page', '1');
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
    const params = new URLSearchParams(searchParams.toString());
    for (const key of ['audit_branch_id', 'audit_date_from', 'audit_date_to', 'audit_action', 'audit_entity_type', 'audit_page', 'audit_limit']) {
      params.delete(key);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">System Activity</h3>

      <AuditLogFilterBar
        filters={{ branchId, dateFrom, dateTo, action, entityType }}
        onChange={(updates) =>
          pushParams(
            {
              audit_branch_id: updates.branch_id ?? null,
              audit_date_from: updates.date_from ?? null,
              audit_date_to: updates.date_to ?? null,
              audit_action: updates.action ?? null,
              audit_entity_type: updates.entity_type ?? null,
            },
            true,
          )
        }
      />

      <DataTable
        columns={columns}
        data={logs}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={(next) =>
          pushParams({ audit_page: String(next.pageIndex + 1), audit_limit: String(next.pageSize) }, false)
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

export function AuditLogsPanel() {
  return (
    <Suspense fallback={<div>Loading audit logs...</div>}>
      <AuditLogsPanelContent />
    </Suspense>
  );
}
