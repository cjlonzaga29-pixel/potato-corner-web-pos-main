'use client';

import { useState } from 'react';
import { FileSearch } from 'lucide-react';
import type { PaginationState } from '@tanstack/react-table';
import type { ExportRequestInput } from '@potato-corner/shared';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ReportFilterBar } from '@/components/reports/report-filter-bar';
import { createLoginAuditColumns } from '@/components/admin/login-audit-columns';
import { useAuditLogReport } from '@/hooks/queries/use-audit-log-report';
import { useRequestExport } from '@/hooks/queries/use-reports';
import { manilaToday, manilaDaysAgo } from '@/lib/manila-date';

const DEFAULT_RANGE_DAYS = 7;

const columns = createLoginAuditColumns();

export function LoginAuditPanel() {
  const [branchId, setBranchId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(() => manilaDaysAgo(DEFAULT_RANGE_DAYS));
  const [dateTo, setDateTo] = useState(() => manilaToday());
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const exportFilters = { branch_id: branchId ?? undefined, date_from: dateFrom, date_to: dateTo, page: 1, limit: 100 };
  const filters = {
    branch_id: branchId ?? undefined,
    date_from: dateFrom,
    date_to: dateTo,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  };
  const { data, isLoading, isError, refetch } = useAuditLogReport(filters);
  const requestExport = useRequestExport();

  function handleExport(format: 'csv' | 'pdf') {
    const setIsExporting = format === 'csv' ? setIsExportingCsv : setIsExportingPdf;
    setIsExporting(true);
    // Exports the full date/branch scope regardless of which on-screen page
    // is currently displayed — matches every other report export in this module.
    const input: ExportRequestInput = { report_type: 'AUDIT_LOG', filters: exportFilters, format };
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
        isExportingCsv={isExportingCsv}
        isExportingPdf={isExportingPdf}
        showBranchSelector
      />

      <DataTable
        stickyHeader
        columns={columns}
        data={data?.data ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        emptyState={<EmptyState icon={FileSearch} title="No login events found" description="No login activity has been recorded in this range." />}
      />
    </div>
  );
}
