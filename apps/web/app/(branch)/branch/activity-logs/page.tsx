'use client';

import { useState } from 'react';
import { FileSearch } from 'lucide-react';
import type { PaginationState } from '@tanstack/react-table';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { createAuditLogColumns } from '@/components/admin/audit-log-columns';
import { HistoricalShiftRecords } from '@/components/branch-ops/historical-shift-records';
import { useAuditLogs } from '@/hooks/queries/use-audit-logs';
import { manilaToday, manilaDaysAgo } from '@/lib/manila-date';

const columns = createAuditLogColumns();

/**
 * GET /api/audit (CR-003) admits branch accounts alongside admin/supervisor
 * — auditService.listLogs auto-scopes non-admin callers to their own
 * accessible branch_ids, so this never passes a branch_id filter itself.
 */
export default function BranchActivityLogsPage() {
  const [dateFrom, setDateFrom] = useState(() => manilaDaysAgo(7));
  const [dateTo, setDateTo] = useState(() => manilaToday());
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const { data, isLoading, isError, refetch } = useAuditLogs({
    date_from: dateFrom,
    date_to: dateTo,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Activity Logs</h1>
        <p className="text-sm text-muted-foreground">Every recorded action taken at your branch.</p>
      </div>

      <Tabs defaultValue="audit-log" className="space-y-4">
        <TabsList>
          <TabsTrigger value="audit-log">Audit Log</TabsTrigger>
          <TabsTrigger value="historical-shift-records">Historical Shift Records</TabsTrigger>
        </TabsList>

        <TabsContent value="audit-log" className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Label htmlFor="activity-log-from">From</Label>
              <Input id="activity-log-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="activity-log-to">To</Label>
              <Input id="activity-log-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
          </div>

          <DataTable
            columns={columns}
            data={data?.logs ?? []}
            isLoading={isLoading}
            isError={isError}
            onRetry={() => void refetch()}
            pagination={pagination}
            onPaginationChange={setPagination}
            rowCount={data?.total ?? 0}
            emptyState={<EmptyState icon={FileSearch} title="No activity found" description="No actions have been recorded in this range." />}
          />
        </TabsContent>

        <TabsContent value="historical-shift-records">
          <HistoricalShiftRecords />
        </TabsContent>
      </Tabs>
    </div>
  );
}
