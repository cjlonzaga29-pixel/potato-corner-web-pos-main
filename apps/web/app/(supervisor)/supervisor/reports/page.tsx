'use client';

import { useEffect, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { AttendanceResponse, ExportReadyPayload, ExportRequestInput, MovementResponse, ShiftResponse, TransactionResponse } from '@potato-corner/shared';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { StatusBadge } from '@/components/shared/status-badge';
import { ShiftStatusBadge } from '@/components/admin/shifts/shift-status-badge';
import { ReportLastUpdated } from '@/components/reports/report-last-updated';
import { formatCurrency, formatDateTime, formatDuration, formatTimeAgo } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useBranchStore } from '@/stores/branch.store';
import { useShifts, useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';
import { useTransactions, useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { useInventoryMovements, useInventoryRealtimeSync } from '@/hooks/queries/use-inventory';
import { useAttendanceByBranch, useAttendanceRealtimeSync } from '@/hooks/queries/use-attendance';
import { useEmployees } from '@/hooks/queries/use-employees';
import { useRequestExport, useReportsRealtimeSync } from '@/hooks/queries/use-reports';

const DEFAULT_RANGE_DAYS = 7;
const QUERY_LIMIT = 100;
const REFRESH_COOLDOWN_SECONDS = 60;

const TAB_TO_REPORT_TYPE: Record<string, ExportRequestInput['report_type']> = {
  'daily-sales': 'DAILY_SALES',
  'shift-summary': 'SHIFT_SUMMARY',
  'cash-reconciliation': 'CASH_RECONCILIATION',
  'void-refund': 'VOID_REFUND',
  'discount-compliance': 'DISCOUNT_COMPLIANCE',
  'inventory-movement': 'INVENTORY_MOVEMENT',
  'attendance-summary': 'ATTENDANCE_SUMMARY',
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayDateString(): string {
  return dateString(new Date());
}

function daysAgoDateString(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return dateString(date);
}

function startOfDayISO(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}

function endOfDayISO(dateStr: string): string {
  return new Date(`${dateStr}T23:59:59.999`).toISOString();
}

function humanizeSnake(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function varianceApprovalLabel(approved: boolean | null): { label: string; variant: 'active' | 'critical' | 'pending' } {
  if (approved === true) return { label: 'Approved', variant: 'active' };
  if (approved === false) return { label: 'Rejected', variant: 'critical' };
  return { label: 'Pending', variant: 'pending' };
}

interface VoidRefundRow {
  transaction: TransactionResponse;
  type: 'void' | 'refund';
}

const dailySalesColumns: ColumnDef<TransactionResponse>[] = [
  { id: 'receipt_number', header: 'Receipt #', accessorKey: 'receipt_number' },
  {
    id: 'payment_method',
    header: 'Payment',
    cell: ({ row }) => <Badge variant="outline">{humanizeSnake(row.original.payment_method)}</Badge>,
  },
  { id: 'total_amount', header: 'Total', cell: ({ row }) => formatCurrency(row.original.total_amount) },
  { id: 'vat_amount', header: 'VAT', cell: ({ row }) => formatCurrency(row.original.vat_amount) },
  { id: 'discount_amount', header: 'Discount', cell: ({ row }) => formatCurrency(row.original.discount_amount) },
  {
    id: 'discount_type',
    header: 'Discount Type',
    cell: ({ row }) => (row.original.discount_type ? humanizeSnake(row.original.discount_type) : '—'),
  },
  { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
];

const shiftSummaryColumns: ColumnDef<ShiftResponse>[] = [
  { id: 'started_at', header: 'Started', cell: ({ row }) => formatDateTime(row.original.started_at) },
  {
    id: 'closed_at',
    header: 'Closed',
    cell: ({ row }) => (row.original.closed_at ? formatDateTime(row.original.closed_at) : 'Still open'),
  },
  { id: 'status', header: 'Status', cell: ({ row }) => <ShiftStatusBadge status={row.original.status} /> },
  { id: 'transaction_count', header: 'Transactions', accessorKey: 'transaction_count' },
  { id: 'cash_sales_total', header: 'Cash Sales', cell: ({ row }) => formatCurrency(row.original.cash_sales_total) },
  { id: 'gcash_sales_total', header: 'GCash Sales', cell: ({ row }) => formatCurrency(row.original.gcash_sales_total) },
  { id: 'total_discount_amount', header: 'Discounts', cell: ({ row }) => formatCurrency(row.original.total_discount_amount) },
  {
    id: 'cash_variance',
    header: 'Variance',
    cell: ({ row }) => {
      const variance = row.original.cash_variance;
      if (variance === null) return '—';
      return <span className={variance < 0 ? 'text-destructive' : ''}>{formatCurrency(variance)}</span>;
    },
  },
];

const cashReconciliationColumns: ColumnDef<ShiftResponse>[] = [
  { id: 'started_at', header: 'Started', cell: ({ row }) => formatDateTime(row.original.started_at) },
  {
    id: 'closed_at',
    header: 'Closed',
    cell: ({ row }) => (row.original.closed_at ? formatDateTime(row.original.closed_at) : 'Still open'),
  },
  { id: 'opening_cash_amount', header: 'Opening Cash', cell: ({ row }) => formatCurrency(row.original.opening_cash_amount) },
  {
    id: 'expected_closing_cash',
    header: 'Expected Closing',
    cell: ({ row }) => (row.original.expected_closing_cash === null ? '—' : formatCurrency(row.original.expected_closing_cash)),
  },
  {
    id: 'closing_cash_amount',
    header: 'Actual Closing',
    cell: ({ row }) => (row.original.closing_cash_amount === null ? '—' : formatCurrency(row.original.closing_cash_amount)),
  },
  {
    id: 'cash_variance',
    header: 'Variance',
    cell: ({ row }) => {
      const variance = row.original.cash_variance;
      if (variance === null) return '—';
      const tone = variance < 0 ? 'text-destructive' : variance === 0 ? 'text-green-600 dark:text-green-400' : '';
      return <span className={tone}>{formatCurrency(variance)}</span>;
    },
  },
  {
    id: 'variance_approved',
    header: 'Approval',
    cell: ({ row }) => {
      const { label, variant } = varianceApprovalLabel(row.original.variance_approved);
      return <Badge variant={variant}>{label}</Badge>;
    },
  },
];

const voidRefundColumns: ColumnDef<VoidRefundRow>[] = [
  { id: 'receipt_number', header: 'Receipt #', cell: ({ row }) => row.original.transaction.receipt_number },
  {
    id: 'type',
    header: 'Type',
    cell: ({ row }) => (
      <Badge variant={row.original.type === 'void' ? 'critical' : 'warning'}>
        {row.original.type === 'void' ? 'Void' : 'Refund'}
      </Badge>
    ),
  },
  { id: 'total_amount', header: 'Amount', cell: ({ row }) => formatCurrency(row.original.transaction.total_amount) },
  {
    id: 'reason',
    header: 'Reason',
    cell: ({ row }) => row.original.transaction.void_reason ?? row.original.transaction.refund_reason ?? '—',
  },
  {
    id: 'when',
    header: 'When',
    cell: ({ row }) => {
      const timestamp = row.original.transaction.voided_at ?? row.original.transaction.refunded_at;
      return timestamp ? formatTimeAgo(timestamp) : '—';
    },
  },
];

const discountComplianceColumns: ColumnDef<TransactionResponse>[] = [
  { id: 'receipt_number', header: 'Receipt #', accessorKey: 'receipt_number' },
  {
    id: 'discount_type',
    header: 'Discount Type',
    cell: ({ row }) =>
      row.original.discount_type ? <Badge variant="secondary">{humanizeSnake(row.original.discount_type)}</Badge> : '—',
  },
  { id: 'discount_amount', header: 'Discount', cell: ({ row }) => formatCurrency(row.original.discount_amount) },
  { id: 'total_amount', header: 'Total', cell: ({ row }) => formatCurrency(row.original.total_amount) },
  { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
];

const inventoryMovementColumns: ColumnDef<MovementResponse>[] = [
  { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
  { id: 'ingredient_name', header: 'Ingredient', accessorKey: 'ingredient_name' },
  {
    id: 'movement_type',
    header: 'Type',
    cell: ({ row }) => <Badge variant="outline">{humanizeSnake(row.original.movement_type)}</Badge>,
  },
  { id: 'quantity_change', header: 'Change', cell: ({ row }) => row.original.quantity_change },
  { id: 'quantity_before', header: 'Before', cell: ({ row }) => row.original.quantity_before },
  { id: 'quantity_after', header: 'After', cell: ({ row }) => row.original.quantity_after },
  { id: 'notes', header: 'Notes', cell: ({ row }) => row.original.notes ?? '—' },
];

function createAttendanceSummaryColumns(employeeNames: Map<string, string>): ColumnDef<AttendanceResponse>[] {
  return [
    { id: 'employee', header: 'Employee', cell: ({ row }) => employeeNames.get(row.original.employee_id) ?? row.original.employee_id },
    { id: 'clock_in_server_time', header: 'Clock In', cell: ({ row }) => formatDateTime(row.original.clock_in_server_time) },
    {
      id: 'clock_out_server_time',
      header: 'Clock Out',
      cell: ({ row }) => (row.original.clock_out_server_time ? formatDateTime(row.original.clock_out_server_time) : 'Still clocked in'),
    },
    { id: 'break_minutes', header: 'Break', cell: ({ row }) => formatDuration(row.original.break_minutes) },
    {
      id: 'actual_work_minutes',
      header: 'Worked',
      cell: ({ row }) => (row.original.actual_work_minutes === null ? '—' : formatDuration(row.original.actual_work_minutes)),
    },
    { id: 'overtime_minutes', header: 'Overtime', cell: ({ row }) => formatDuration(row.original.overtime_minutes) },
    { id: 'gps', header: 'GPS', cell: ({ row }) => <StatusBadge status={row.original.clock_in_gps_status} type="gps" /> },
  ];
}

/**
 * Real-time-only report tier (Phase 20 scope lock): every report below is
 * composed client-side from existing list queries. Branch is implicit from
 * useBranchStore, matching every other supervisor data page.
 *
 * (Phase 16 note: export, manual refresh with a cooldown, and export-ready
 * realtime notifications are layered on top via the new /api/reports/export
 * endpoint — the 7 tabs' underlying data still come from this lightweight
 * client-composed tier, unchanged.)
 *
 * All queries below are fired unconditionally and in parallel (no
 * sequential/waterfall awaits) so every tab's data is ready by the time the
 * user switches to it, and are capped at limit=100 (the API's max page
 * size) — a known ceiling of this lightweight tier, not a bug: a branch
 * with more than 100 matching rows in the selected range will only
 * aggregate over its most recent 100.
 *
 * The date range lives at the page level (not per-tab) so switching tabs
 * never resets it. GET /api/cash has no date_from/date_to filter, so the
 * Shift Summary and Cash Reconciliation tabs fetch up to 100 shifts and
 * filter by started_at client-side instead.
 */
export default function SupervisorReportsPage() {
  useShiftsRealtimeSync();
  useTransactionsRealtimeSync();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  useInventoryRealtimeSync(activeBranchId);
  useAttendanceRealtimeSync();

  const currentUserId = useAuthStore((s) => s.user?.id);
  const requestExport = useRequestExport();
  const [activeTab, setActiveTab] = useState('daily-sales');
  const [refreshDisabled, setRefreshDisabled] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);

  useReportsRealtimeSync((payload: ExportReadyPayload) => {
    if (payload.requester_id !== currentUserId) return;
    toast.success('Export ready', {
      description: `Your ${payload.report_type} export is ready`,
      action: { label: 'Download', onClick: () => window.open(payload.download_url, '_blank') },
      duration: 30_000,
    });
  });

  useEffect(() => {
    if (!refreshDisabled) return;
    if (refreshCooldown <= 0) {
      setRefreshDisabled(false);
      return;
    }
    const timer = setInterval(() => setRefreshCooldown((s) => s - 1), 1000);
    return () => clearInterval(timer);
  }, [refreshDisabled, refreshCooldown]);

  const [fromInput, setFromInput] = useState(() => daysAgoDateString(DEFAULT_RANGE_DAYS));
  const [toInput, setToInput] = useState(() => todayDateString());
  const [dateRange, setDateRange] = useState(() => ({ from: daysAgoDateString(DEFAULT_RANGE_DAYS), to: todayDateString() }));

  const rangeStartISO = startOfDayISO(dateRange.from);
  const rangeEndISO = endOfDayISO(dateRange.to);

  const completedQuery = useTransactions({
    branch_id: activeBranchId ?? undefined,
    status: 'completed',
    date_from: dateRange.from,
    date_to: dateRange.to,
    limit: QUERY_LIMIT,
  });
  const allShiftsQuery = useShifts({ branch_id: activeBranchId ?? undefined, page: 1, limit: QUERY_LIMIT });
  const closedShiftsQuery = useShifts({ branch_id: activeBranchId ?? undefined, status: 'closed', page: 1, limit: QUERY_LIMIT });
  const voidedQuery = useTransactions({
    branch_id: activeBranchId ?? undefined,
    status: 'voided',
    date_from: dateRange.from,
    date_to: dateRange.to,
    limit: QUERY_LIMIT,
  });
  const refundedQuery = useTransactions({
    branch_id: activeBranchId ?? undefined,
    status: 'refunded',
    date_from: dateRange.from,
    date_to: dateRange.to,
    limit: QUERY_LIMIT,
  });
  const movementsQuery = useInventoryMovements(activeBranchId, { from_date: dateRange.from, to_date: dateRange.to, page: 1, limit: QUERY_LIMIT });
  const attendanceQuery = useAttendanceByBranch(activeBranchId, { from: rangeStartISO, to: rangeEndISO, page: 1, limit: QUERY_LIMIT });
  const employeesQuery = useEmployees({ branchId: activeBranchId ?? undefined, limit: QUERY_LIMIT });

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its reports.</p>;
  }

  function handleRefresh() {
    setDateRange({ from: fromInput, to: toInput });
    setRefreshDisabled(true);
    setRefreshCooldown(REFRESH_COOLDOWN_SECONDS);
  }

  function handleExport(format: 'csv' | 'pdf') {
    const input: ExportRequestInput = {
      report_type: TAB_TO_REPORT_TYPE[activeTab] ?? 'DAILY_SALES',
      filters: { branch_id: activeBranchId ?? undefined, date_from: dateRange.from, date_to: dateRange.to, page: 1, limit: QUERY_LIMIT },
      format,
    };
    requestExport.mutate(input);
  }

  // Daily Sales
  const completedTransactions = completedQuery.data?.transactions ?? [];
  const totalTransactions = completedTransactions.length;
  const grossSales = completedTransactions.reduce((sum, t) => sum + t.total_amount, 0);
  const vatCollected = completedTransactions.reduce((sum, t) => sum + t.vat_amount, 0);
  const discountsGiven = completedTransactions.reduce((sum, t) => sum + t.discount_amount, 0);

  // Shift Summary
  const shiftsInRange = (allShiftsQuery.data?.shifts ?? []).filter((s) => s.started_at >= rangeStartISO && s.started_at <= rangeEndISO);
  const totalShifts = shiftsInRange.length;
  const completedShifts = shiftsInRange.filter((s) => s.status === 'closed').length;
  const flaggedShifts = shiftsInRange.filter((s) => s.status === 'flagged').length;
  const shiftSummaryRevenue = shiftsInRange.reduce((sum, s) => sum + s.cash_sales_total + s.gcash_sales_total, 0);

  // Cash Reconciliation
  const closedShiftsInRange = (closedShiftsQuery.data?.shifts ?? []).filter(
    (s) => s.started_at >= rangeStartISO && s.started_at <= rangeEndISO,
  );
  const closedShiftsCount = closedShiftsInRange.length;
  const shiftsWithVariance = closedShiftsInRange.filter((s) => s.cash_variance !== null && s.cash_variance !== 0).length;
  const totalVarianceAmount = closedShiftsInRange.reduce((sum, s) => sum + (s.cash_variance ?? 0), 0);
  const autoApprovedVariances = closedShiftsInRange.filter((s) => s.variance_approved === true).length;

  // Void/Refund
  const voidedTransactions = voidedQuery.data?.transactions ?? [];
  const refundedTransactions = refundedQuery.data?.transactions ?? [];
  const totalVoided = voidedTransactions.length;
  const totalRefunded = refundedTransactions.length;
  const voidedAmount = voidedTransactions.reduce((sum, t) => sum + t.total_amount, 0);
  const refundedAmount = refundedTransactions.reduce((sum, t) => sum + t.total_amount, 0);
  const voidRefundRows: VoidRefundRow[] = [
    ...voidedTransactions.map((transaction): VoidRefundRow => ({ transaction, type: 'void' })),
    ...refundedTransactions.map((transaction): VoidRefundRow => ({ transaction, type: 'refund' })),
  ];
  const voidRefundLoading = voidedQuery.isLoading || refundedQuery.isLoading;
  const voidRefundError = voidedQuery.isError || refundedQuery.isError;

  // Discount Compliance (reuses the completed-transactions fetch above)
  const discountedTransactions = completedTransactions.filter((t) => t.discount_type !== null);
  const totalDiscountedTransactions = discountedTransactions.length;
  const pwdDiscounts = discountedTransactions.filter((t) => t.discount_type === 'pwd').length;
  const seniorCitizenDiscounts = discountedTransactions.filter((t) => t.discount_type === 'senior_citizen').length;
  const totalDiscountAmount = discountedTransactions.reduce((sum, t) => sum + t.discount_amount, 0);

  // Inventory Movement
  const movements = movementsQuery.data?.movements ?? [];
  const totalMovements = movements.length;
  const stockInCount = movements.filter((m) => m.movement_type === 'stock_in').length;
  const wasteCount = movements.filter((m) => m.movement_type === 'waste').length;
  const adjustmentsCount = movements.filter((m) => m.movement_type === 'manual_adjustment').length;

  // Attendance Summary
  const attendanceRecords = attendanceQuery.data?.records ?? [];
  const totalStaffToday = attendanceRecords.length;
  const clockedInNow = attendanceRecords.filter((r) => r.clock_out_server_time === null).length;
  const totalWorkMinutes = attendanceRecords.reduce((sum, r) => sum + (r.actual_work_minutes ?? 0), 0);
  const overtimeMinutesSum = attendanceRecords.reduce((sum, r) => sum + r.overtime_minutes, 0);
  const employeeNames = new Map((employeesQuery.data?.employees ?? []).map((e) => [e.id, `${e.first_name} ${e.last_name}`]));
  const attendanceSummaryColumns = createAttendanceSummaryColumns(employeeNames);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Branch Reports</h1>
        <p className="text-sm text-muted-foreground">Real-time reports composed from live data for your active branch.</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="reports-from">From</Label>
          <Input id="reports-from" type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="reports-to">To</Label>
          <Input id="reports-to" type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} />
        </div>
        <Button onClick={handleRefresh} disabled={refreshDisabled}>
          {refreshDisabled ? `Refresh (${refreshCooldown}s)` : 'Refresh'}
        </Button>
        <Button variant="outline" onClick={() => handleExport('csv')} disabled={requestExport.isPending}>
          Export CSV
        </Button>
        <Button variant="outline" onClick={() => handleExport('pdf')} disabled={requestExport.isPending}>
          Export PDF
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="daily-sales">Daily Sales</TabsTrigger>
          <TabsTrigger value="shift-summary">Shift Summary</TabsTrigger>
          <TabsTrigger value="cash-reconciliation">Cash Reconciliation</TabsTrigger>
          <TabsTrigger value="void-refund">Void/Refund</TabsTrigger>
          <TabsTrigger value="discount-compliance">Discount Compliance</TabsTrigger>
          <TabsTrigger value="inventory-movement">Inventory Movement</TabsTrigger>
          <TabsTrigger value="attendance-summary">Attendance Summary</TabsTrigger>
        </TabsList>

        <TabsContent value="daily-sales" className="space-y-4">
          <ReportLastUpdated
            timestamp={completedQuery.dataUpdatedAt ? new Date(completedQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={completedQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Total Transactions" value={totalTransactions} isLoading={completedQuery.isLoading} />
            <KpiCard title="Gross Sales" value={grossSales} prefix="₱" isLoading={completedQuery.isLoading} />
            <KpiCard title="VAT Collected" value={vatCollected} prefix="₱" isLoading={completedQuery.isLoading} />
            <KpiCard title="Discounts Given" value={discountsGiven} prefix="₱" isLoading={completedQuery.isLoading} />
          </div>
          <DataTable
            columns={dailySalesColumns}
            data={completedTransactions}
            isLoading={completedQuery.isLoading}
            isError={completedQuery.isError}
            onRetry={() => void completedQuery.refetch()}
            emptyState={<EmptyState title="No sales" description="No completed transactions in this date range." />}
          />
        </TabsContent>

        <TabsContent value="shift-summary" className="space-y-4">
          <ReportLastUpdated
            timestamp={allShiftsQuery.dataUpdatedAt ? new Date(allShiftsQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={allShiftsQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Total Shifts" value={totalShifts} isLoading={allShiftsQuery.isLoading} />
            <KpiCard title="Completed Shifts" value={completedShifts} isLoading={allShiftsQuery.isLoading} />
            <KpiCard title="Flagged Shifts" value={flaggedShifts} isLoading={allShiftsQuery.isLoading} tone={flaggedShifts > 0 ? 'warning' : 'default'} />
            <KpiCard title="Total Revenue" value={shiftSummaryRevenue} prefix="₱" isLoading={allShiftsQuery.isLoading} />
          </div>
          <DataTable
            columns={shiftSummaryColumns}
            data={shiftsInRange}
            isLoading={allShiftsQuery.isLoading}
            isError={allShiftsQuery.isError}
            onRetry={() => void allShiftsQuery.refetch()}
            emptyState={<EmptyState title="No shifts" description="No shifts started in this date range." />}
          />
        </TabsContent>

        <TabsContent value="cash-reconciliation" className="space-y-4">
          <ReportLastUpdated
            timestamp={closedShiftsQuery.dataUpdatedAt ? new Date(closedShiftsQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={closedShiftsQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Closed Shifts" value={closedShiftsCount} isLoading={closedShiftsQuery.isLoading} />
            <KpiCard title="Shifts with Variance" value={shiftsWithVariance} isLoading={closedShiftsQuery.isLoading} />
            <KpiCard title="Total Variance Amount" value={totalVarianceAmount} prefix="₱" isLoading={closedShiftsQuery.isLoading} />
            <KpiCard title="Auto-Approved Variances" value={autoApprovedVariances} isLoading={closedShiftsQuery.isLoading} />
          </div>
          <DataTable
            columns={cashReconciliationColumns}
            data={closedShiftsInRange}
            isLoading={closedShiftsQuery.isLoading}
            isError={closedShiftsQuery.isError}
            onRetry={() => void closedShiftsQuery.refetch()}
            emptyState={<EmptyState title="No closed shifts" description="No closed shifts in this date range." />}
          />
        </TabsContent>

        <TabsContent value="void-refund" className="space-y-4">
          <ReportLastUpdated
            timestamp={
              voidedQuery.dataUpdatedAt || refundedQuery.dataUpdatedAt
                ? new Date(Math.max(voidedQuery.dataUpdatedAt, refundedQuery.dataUpdatedAt)).toISOString()
                : undefined
            }
            isLoading={voidRefundLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Total Voided" value={totalVoided} isLoading={voidRefundLoading} />
            <KpiCard title="Total Refunded" value={totalRefunded} isLoading={voidRefundLoading} />
            <KpiCard title="Voided Amount" value={voidedAmount} prefix="₱" isLoading={voidRefundLoading} />
            <KpiCard title="Refunded Amount" value={refundedAmount} prefix="₱" isLoading={voidRefundLoading} />
          </div>
          <DataTable
            columns={voidRefundColumns}
            data={voidRefundRows}
            isLoading={voidRefundLoading}
            isError={voidRefundError}
            onRetry={() => {
              void voidedQuery.refetch();
              void refundedQuery.refetch();
            }}
            emptyState={<EmptyState title="No voids or refunds" description="No voided or refunded transactions in this date range." />}
          />
        </TabsContent>

        <TabsContent value="discount-compliance" className="space-y-4">
          <ReportLastUpdated
            timestamp={completedQuery.dataUpdatedAt ? new Date(completedQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={completedQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Total Discounted Transactions" value={totalDiscountedTransactions} isLoading={completedQuery.isLoading} />
            <KpiCard title="PWD Discounts" value={pwdDiscounts} isLoading={completedQuery.isLoading} />
            <KpiCard title="Senior Citizen Discounts" value={seniorCitizenDiscounts} isLoading={completedQuery.isLoading} />
            <KpiCard title="Total Discount Amount" value={totalDiscountAmount} prefix="₱" isLoading={completedQuery.isLoading} />
          </div>
          <DataTable
            columns={discountComplianceColumns}
            data={discountedTransactions}
            isLoading={completedQuery.isLoading}
            isError={completedQuery.isError}
            onRetry={() => void completedQuery.refetch()}
            emptyState={<EmptyState title="No discounted transactions" description="No discounted transactions in this date range." />}
          />
        </TabsContent>

        <TabsContent value="inventory-movement" className="space-y-4">
          <ReportLastUpdated
            timestamp={movementsQuery.dataUpdatedAt ? new Date(movementsQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={movementsQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Total Movements" value={totalMovements} isLoading={movementsQuery.isLoading} />
            <KpiCard title="Stock In" value={stockInCount} isLoading={movementsQuery.isLoading} />
            <KpiCard title="Waste" value={wasteCount} isLoading={movementsQuery.isLoading} />
            <KpiCard title="Adjustments" value={adjustmentsCount} isLoading={movementsQuery.isLoading} />
          </div>
          <DataTable
            columns={inventoryMovementColumns}
            data={movements}
            isLoading={movementsQuery.isLoading}
            isError={movementsQuery.isError}
            onRetry={() => void movementsQuery.refetch()}
            emptyState={<EmptyState title="No inventory movements" description="No stock movements recorded in this date range." />}
          />
        </TabsContent>

        <TabsContent value="attendance-summary" className="space-y-4">
          <ReportLastUpdated
            timestamp={attendanceQuery.dataUpdatedAt ? new Date(attendanceQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={attendanceQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Total Staff Today" value={totalStaffToday} isLoading={attendanceQuery.isLoading} />
            <KpiCard title="Clocked In Now" value={clockedInNow} isLoading={attendanceQuery.isLoading} />
            <KpiCard title="Total Hours Worked" value={totalWorkMinutes / 60} suffix="h" isLoading={attendanceQuery.isLoading} />
            <KpiCard title="Overtime Hours" value={overtimeMinutesSum / 60} suffix="h" isLoading={attendanceQuery.isLoading} />
          </div>
          <DataTable
            columns={attendanceSummaryColumns}
            data={attendanceRecords}
            isLoading={attendanceQuery.isLoading}
            isError={attendanceQuery.isError}
            onRetry={() => void attendanceQuery.refetch()}
            emptyState={<EmptyState title="No attendance records" description="No clock-in/out records in this date range." />}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
