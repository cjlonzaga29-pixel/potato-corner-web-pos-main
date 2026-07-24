'use client';

import { useState } from 'react';
import { FileSearch } from 'lucide-react';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createAuditLogColumns } from '@/components/admin/audit-log-columns';
import { useAuditLogs } from '@/hooks/queries/use-audit-logs';

const columns = createAuditLogColumns();

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoDateString(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * GET /api/audit (CR-003) admits branch accounts alongside admin/supervisor
 * — auditService.listLogs auto-scopes non-admin callers to their own
 * accessible branch_ids, so this never passes a branch_id filter itself.
 */
export default function BranchActivityLogsPage() {
  const [dateFrom, setDateFrom] = useState(() => daysAgoDateString(7));
  const [dateTo, setDateTo] = useState(() => todayDateString());
  const { data, isLoading, isError, refetch } = useAuditLogs({ date_from: dateFrom, date_to: dateTo, limit: 50 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Activity Logs</h1>
        <p className="text-sm text-muted-foreground">Every recorded action taken at your branch.</p>
      </div>

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
        emptyState={<EmptyState icon={FileSearch} title="No activity found" description="No actions have been recorded in this range." />}
      />
    </div>
  );
}
