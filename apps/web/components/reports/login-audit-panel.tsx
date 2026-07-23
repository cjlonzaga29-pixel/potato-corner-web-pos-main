'use client';

import { useState } from 'react';
import { FileSearch } from 'lucide-react';
import type { ExportRequestInput } from '@potato-corner/shared';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ReportFilterBar } from '@/components/reports/report-filter-bar';
import { createLoginAuditColumns } from '@/components/admin/login-audit-columns';
import { useAuditLogReport } from '@/hooks/queries/use-audit-log-report';
import { useRequestExport } from '@/hooks/queries/use-reports';

const DEFAULT_RANGE_DAYS = 7;

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoDateString(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const columns = createLoginAuditColumns();

export function LoginAuditPanel() {
  const [branchId, setBranchId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(() => daysAgoDateString(DEFAULT_RANGE_DAYS));
  const [dateTo, setDateTo] = useState(() => todayDateString());
  const [isExporting, setIsExporting] = useState(false);

  const filters = { branch_id: branchId ?? undefined, date_from: dateFrom, date_to: dateTo, page: 1, limit: 100 };
  const { data, isLoading, isError, refetch } = useAuditLogReport(filters);
  const requestExport = useRequestExport();

  function handleExport(format: 'csv' | 'pdf') {
    setIsExporting(true);
    const input: ExportRequestInput = { report_type: 'AUDIT_LOG', filters, format };
    requestExport.mutate(input, { onSettled: () => setIsExporting(false) });
  }

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">Login &amp; Session Events</h3>

      <ReportFilterBar
        branchId={branchId}
        onBranchChange={setBranchId}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateFromChange={setDateFrom}
        onDateToChange={setDateTo}
        onRefresh={() => void refetch()}
        onExportCsv={() => handleExport('csv')}
        onExportPdf={() => handleExport('pdf')}
        isRefreshDisabled={false}
        refreshCooldownSeconds={0}
        isExporting={isExporting}
        showBranchSelector
      />

      <DataTable
        columns={columns}
        data={data?.data ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={<EmptyState icon={FileSearch} title="No login events found" description="No login activity has been recorded in this range." />}
      />
    </div>
  );
}
