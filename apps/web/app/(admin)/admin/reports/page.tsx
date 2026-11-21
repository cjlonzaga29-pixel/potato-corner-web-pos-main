'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';
import type {
  DailySalesReportRow,
  VoidRefundReportRow,
  DiscountComplianceReportRow,
  InventoryMovementReportRow,
  IngredientWeightKgRow,
  PackagingPcRow,
  AttendanceSummaryReportRow,
  ExportReadyPayload,
  ExportRequestInput,
} from '@potato-corner/shared';
import { expenseDisplayName, reportTypeDisplayName } from '@potato-corner/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/shared/status-badge';
import { ReportFilterBar } from '@/components/reports/report-filter-bar';
import { ReportsSectionTabs } from '@/components/reports/reports-section-tabs';
import { ReportLastUpdated } from '@/components/reports/report-last-updated';
import { DailySalesDrilldown } from '@/components/reports/daily-sales-drilldown';
import { DiscountComplianceDrilldown } from '@/components/reports/discount-compliance-drilldown';
import { DiscountCoverageNotice } from '@/components/reports/discount-coverage-notice';
import { DiscountProofSummary } from '@/components/reports/discount-proof-summary';
import { ALL_DISCOUNT_TYPES, DiscountTypeFilter } from '@/components/reports/discount-type-filter';
import { getDiscountBreakdownColumns } from '@/components/reports/discount-type-breakdown-columns';
import { FinancialSummaryPanel } from '@/components/reports/financial-summary-panel';
import { InventoryAnalyticsPanel } from '@/components/reports/inventory-analytics-panel';
import { WidgetErrorBoundary } from '@/components/shared/widget-error-boundary';
import { createExpenseColumns } from '@/components/admin/expense-columns';
import { AdminAttendanceReport } from '@/components/admin/admin-attendance-report';
import { ExpenseBreakdownCard } from '@/components/reports/expense-breakdown-card';
import { ExtraSupplySummaryCard } from '@/components/extra-supplies/extra-supply-summary-card';
import { ExtraSupplyHistory } from '@/components/extra-supplies/extra-supply-history';
import { ViewInventoryMovementProofDialog } from '@/components/shared/transactions/view-inventory-movement-proof-dialog';
import { ViewExpenseReceiptDialog, type ExpenseReceiptProofData } from '@/components/shared/transactions/view-expense-receipt-dialog';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { discountTypeOptions, mergeDiscountRows, summarizeDiscountProof } from '@/lib/discount-report';
import { movementTypeLabel } from '@/lib/inventory-movement-labels';
import { manilaToday, manilaDaysAgo } from '@/lib/manila-date';
import { ATTENDANCE_RECORDS_REPORT_TAB, EXTRA_SUPPLIES_REPORT_TAB } from '@/lib/admin-report-redirect';
import { useAuthStore } from '@/stores/auth.store';
import { useExpenses, useExpensesRealtimeSync } from '@/hooks/queries/use-expenses';
import {
  useDailySalesReport,
  useVoidRefundReport,
  useDiscountComplianceReport,
  useInventoryMovementReport,
  useInventorySummaryReport,
  useAttendanceSummaryReport,
  useRequestExport,
  useReportsRealtimeSync,
  useReportsTrendsRealtimeSync,
  useInventoryAnalyticsRealtimeSync,
} from '@/hooks/queries/use-reports';

const REFRESH_COOLDOWN_SECONDS = 60;
const DEFAULT_RANGE_DAYS = 7;
const EXPENSES_PAGE_SIZE = 25;

/** Below `md`, Inventory Summary renders one card per row instead of the wide KG/PC tables — same breakpoint hook as Universal Inventory's column-hiding. Defaults to desktop (matches before mount, and in non-browser test environments). */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(min-width: 768px)');
    setIsDesktop(query.matches);
    const listener = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  return isDesktop;
}

function humanize(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** voided/refunded aren't covered by StatusBadge's status maps, so they get an explicit Badge variant here (same fallback pattern used elsewhere for domains StatusBadge doesn't know about). */
const VOID_REFUND_BADGE_VARIANT: Record<VoidRefundReportRow['status'], BadgeProps['variant']> = {
  voided: 'critical',
  refunded: 'warning',
};

function getDailySalesColumns(onViewTransactions: (row: DailySalesReportRow) => void): ColumnDef<DailySalesReportRow>[] {
  return [
    { accessorKey: 'report_date', header: 'Date' },
    { accessorKey: 'branch_name', header: 'Branch' },
    { accessorKey: 'gross_sales', header: 'Gross Sales', cell: ({ row }) => formatCurrency(row.original.gross_sales) },
    { accessorKey: 'discount_total', header: 'Discounts', cell: ({ row }) => formatCurrency(row.original.discount_total) },
    { accessorKey: 'net_sales', header: 'Net Sales', cell: ({ row }) => formatCurrency(row.original.net_sales) },
    { accessorKey: 'completed_count', header: 'Completed' },
    { accessorKey: 'voided_count', header: 'Voided' },
    { accessorKey: 'refunded_count', header: 'Refunded' },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <Button type="button" variant="outline" size="sm" onClick={() => onViewTransactions(row.original)}>
          View Transactions
        </Button>
      ),
    },
  ];
}

const voidRefundColumns: ColumnDef<VoidRefundReportRow>[] = [
  { accessorKey: 'transaction_number', header: 'Receipt #' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'cashier_name', header: 'Cashier' },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <Badge variant={VOID_REFUND_BADGE_VARIANT[row.original.status]}>{humanize(row.original.status)}</Badge>
    ),
  },
  { accessorKey: 'total_amount', header: 'Amount', cell: ({ row }) => formatCurrency(row.original.total_amount) },
  { accessorKey: 'reason', header: 'Reason', cell: ({ row }) => row.original.reason ?? '—' },
  { accessorKey: 'actioned_by_name', header: 'Actioned By', cell: ({ row }) => row.original.actioned_by_name ?? '—' },
];

function createInventoryMovementColumns(onViewProof: (row: InventoryMovementReportRow) => void): ColumnDef<InventoryMovementReportRow>[] {
  return [
    { accessorKey: 'branch_name', header: 'Branch' },
    { accessorKey: 'ingredient_name', header: 'Ingredient' },
    { id: 'movement_type', header: 'Type', cell: ({ row }) => movementTypeLabel(row.original.movement_type) },
    {
      id: 'quantity_change',
      header: 'Change',
      cell: ({ row }) => `${row.original.quantity_change > 0 ? '+' : ''}${row.original.quantity_change} ${row.original.unit}`,
    },
    {
      id: 'quantity_after',
      header: 'Balance After',
      cell: ({ row }) => `${row.original.quantity_after} ${row.original.unit}`,
    },
    { accessorKey: 'recorded_by_name', header: 'Recorded By', cell: ({ row }) => row.original.recorded_by_name ?? '—' },
    {
      accessorKey: 'responsible_user_name',
      header: 'Responsible Staff',
      cell: ({ row }) => row.original.responsible_user_name ?? '—',
    },
    {
      id: 'reason_reference',
      header: 'Reason / Reference',
      cell: ({ row }) =>
        row.original.notes ??
        (row.original.reference_type
          ? `${humanize(row.original.reference_type)}${row.original.reference_id ? ` #${row.original.reference_id.slice(0, 8)}` : ''}`
          : '—'),
    },
    {
      id: 'proof',
      header: 'Proof',
      cell: ({ row }) =>
        row.original.proof_available === 'Yes' ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onViewProof(row.original)}>
            View Proof
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">No Proof</span>
        ),
    },
    { accessorKey: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
  ];
}

// TASK 157/165: Inventory Summary is split into two independently-dimensioned
// tables — Ingredient Weight Consumption (KG) and Packaging Consumption
// (PC) — instead of one mixed-unit table (TASK 144). Every non-COUNT
// ingredient gets a row regardless of whether a KG conversion is configured;
// rows without one show "—" in the KG columns and a "Conversion Needed"
// Status badge instead of being hidden (TASK 165 — previously such rows
// were silently dropped from this table entirely).
const kgOrDash = (v: number | null) => (v === null ? '—' : v);
const ingredientWeightKgColumns: ColumnDef<IngredientWeightKgRow>[] = [
  { accessorKey: 'ingredient_name', header: 'Ingredient' },
  { accessorKey: 'unit_code', header: 'Base Unit' },
  { accessorKey: 'opening_stock', header: 'Beginning Stock (Beg.)' },
  { accessorKey: 'consumed_today', header: 'Stock Used Today (Sales)' },
  { accessorKey: 'consumed_this_month', header: 'Stock Used This Month (Sales)' },
  { accessorKey: 'remaining', header: 'Remaining' },
  { accessorKey: 'opening_stock_kg', header: 'Beginning Stock (KG)', cell: ({ row }) => kgOrDash(row.original.opening_stock_kg) },
  { accessorKey: 'consumed_today_kg', header: 'Stock Used Today - Sales (KG)', cell: ({ row }) => kgOrDash(row.original.consumed_today_kg) },
  { accessorKey: 'consumed_this_month_kg', header: 'Stock Used This Month - Sales (KG)', cell: ({ row }) => kgOrDash(row.original.consumed_this_month_kg) },
  { accessorKey: 'remaining_kg', header: 'Remaining (KG)', cell: ({ row }) => kgOrDash(row.original.remaining_kg) },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <Badge variant={row.original.status === 'converted' ? 'default' : 'secondary'}>
        {row.original.status === 'converted' ? 'Converted' : 'Conversion Needed'}
      </Badge>
    ),
  },
];

const packagingPcColumns: ColumnDef<PackagingPcRow>[] = [
  { accessorKey: 'ingredient_name', header: 'Packaging' },
  { accessorKey: 'opening_stock_pc', header: 'Beginning Stock (PC)' },
  { accessorKey: 'consumed_today_pc', header: 'Stock Used Today - Sales (PC)' },
  { accessorKey: 'consumed_this_month_pc', header: 'Stock Used This Month - Sales (PC)' },
  { accessorKey: 'remaining_pc', header: 'Remaining (PC)' },
];

/** Mobile fallback for Ingredient Weight Consumption — the 11-column table is unusable under md, so small screens get one card per ingredient with the same fields instead. */
function IngredientWeightKgMobileCards({ rows }: { rows: IngredientWeightKgRow[] }) {
  return (
    <div className="space-y-3 md:hidden">
      {rows.map((row) => (
        <div key={row.ingredient_id} className="rounded-xl border border-border/60 bg-card p-4 shadow-panel">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 truncate font-medium">{row.ingredient_name}</p>
            <Badge variant={row.status === 'converted' ? 'default' : 'secondary'} className="shrink-0">
              {row.status === 'converted' ? 'Converted' : 'Conversion Needed'}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">Base unit: {row.unit_code}</p>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <div><p className="text-xs text-muted-foreground">Beginning Stock (Beg.)</p><p>{row.opening_stock}</p></div>
            <div><p className="text-xs text-muted-foreground">Stock Used Today (Sales)</p><p>{row.consumed_today}</p></div>
            <div><p className="text-xs text-muted-foreground">Stock Used This Month (Sales)</p><p>{row.consumed_this_month}</p></div>
            <div><p className="text-xs text-muted-foreground">Remaining</p><p>{row.remaining}</p></div>
            <div><p className="text-xs text-muted-foreground">Beg. (KG)</p><p>{kgOrDash(row.opening_stock_kg)}</p></div>
            <div><p className="text-xs text-muted-foreground">Used Today (KG)</p><p>{kgOrDash(row.consumed_today_kg)}</p></div>
            <div><p className="text-xs text-muted-foreground">Used Month (KG)</p><p>{kgOrDash(row.consumed_this_month_kg)}</p></div>
            <div><p className="text-xs text-muted-foreground">Remaining (KG)</p><p>{kgOrDash(row.remaining_kg)}</p></div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Mobile fallback for Packaging Consumption, matching IngredientWeightKgMobileCards' pattern. */
function PackagingPcMobileCards({ rows }: { rows: PackagingPcRow[] }) {
  return (
    <div className="space-y-3 md:hidden">
      {rows.map((row) => (
        <div key={row.ingredient_id} className="rounded-xl border border-border/60 bg-card p-4 shadow-panel">
          <p className="truncate font-medium">{row.ingredient_name}</p>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <div><p className="text-xs text-muted-foreground">Beg. (PC)</p><p>{row.opening_stock_pc}</p></div>
            <div><p className="text-xs text-muted-foreground">Used Today (PC)</p><p>{row.consumed_today_pc}</p></div>
            <div><p className="text-xs text-muted-foreground">Used Month (PC)</p><p>{row.consumed_this_month_pc}</p></div>
            <div><p className="text-xs text-muted-foreground">Remaining (PC)</p><p>{row.remaining_pc}</p></div>
          </div>
        </div>
      ))}
    </div>
  );
}

const attendanceSummaryColumns: ColumnDef<AttendanceSummaryReportRow>[] = [
  { accessorKey: 'employee_name', header: 'Employee' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { id: 'clock_in', header: 'Time In', cell: ({ row }) => formatDateTime(row.original.clock_in) },
  {
    id: 'clock_out',
    header: 'Time Out',
    cell: ({ row }) => (row.original.clock_out ? formatDateTime(row.original.clock_out) : 'Still clocked in'),
  },
  {
    accessorKey: 'actual_work_minutes',
    header: 'Worked (min)',
    cell: ({ row }) => (row.original.actual_work_minutes === null ? '—' : row.original.actual_work_minutes),
  },
  { accessorKey: 'overtime_minutes', header: 'Overtime (min)' },
  { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} type="attendance" /> },
];

/** Grouped report navigation — every report lives directly in this page, organized into categories rather than a flat tab strip or a disclosure toggle. */
const REPORT_GROUPS: { category: string; reports: { value: string; label: string }[] }[] = [
  {
    category: 'Finance',
    reports: [
      { value: 'FINANCIAL_SUMMARY', label: 'Financial Summary' },
      { value: 'DAILY_SALES', label: 'Daily Sales Report (DSR)' },
      { value: 'EXPENSES', label: 'Expenses' },
    ],
  },
  {
    category: 'Inventory',
    reports: [
      { value: 'INVENTORY_ANALYTICS', label: 'Inventory Analytics' },
      { value: 'INVENTORY_MOVEMENT', label: 'Inventory Movement' },
      { value: 'INVENTORY_SUMMARY', label: 'Inventory Summary' },
      // POS-PERF-P64 — read-only issue history; its supply cost stays apart from cash Expenses.
      { value: EXTRA_SUPPLIES_REPORT_TAB, label: 'Extra Supplies' },
    ],
  },
  {
    category: 'Operations',
    reports: [
      { value: 'ATTENDANCE_SUMMARY', label: 'Attendance Summary' },
      // POS-PERF-P64 — the former /admin/attendance page, read-only (corrections stay with Supervisors).
      { value: ATTENDANCE_RECORDS_REPORT_TAB, label: 'Attendance Records' },
    ],
  },
  {
    category: 'Compliance',
    reports: [
      { value: 'VOID_REFUND', label: 'Void / Refund' },
      { value: 'DISCOUNT_COMPLIANCE', label: 'Discount Report' },
    ],
  },
];

const ALL_REPORT_VALUES = new Set(REPORT_GROUPS.flatMap((g) => g.reports.map((r) => r.value)));

/** Mirrors the `!selectedBranchId` gate already on each of these tabs' "Select a branch" empty state below — kept as one set so the export controls stay in sync with the on-screen gate instead of drifting from it. */
const BRANCH_REQUIRED_REPORTS = new Set([
  'DAILY_SALES',
  'VOID_REFUND',
  'DISCOUNT_COMPLIANCE',
  'INVENTORY_MOVEMENT',
  'INVENTORY_SUMMARY',
  'ATTENDANCE_SUMMARY',
]);

function categoryFor(reportValue: string): string {
  return REPORT_GROUPS.find((g) => g.reports.some((r) => r.value === reportValue))?.category ?? 'Finance';
}

function AdminReportsPageContent() {
  const isDesktop = useIsDesktop();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  useExpensesRealtimeSync();
  useReportsTrendsRealtimeSync();
  useInventoryAnalyticsRealtimeSync();

  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(() => manilaDaysAgo(DEFAULT_RANGE_DAYS));
  const [dateTo, setDateTo] = useState(() => manilaToday());

  const [activeReport, setActiveReport] = useState(() => {
    const tabParam = searchParams.get('tab');
    return tabParam && ALL_REPORT_VALUES.has(tabParam) ? tabParam : 'FINANCIAL_SUMMARY';
  });
  const [activeCategory, setActiveCategory] = useState(() => categoryFor(activeReport));

  // A same-page link (e.g. the Expenses tab's Extra Supplies "View history") changes ?tab=
  // without remounting this page, so follow it here too.
  const tabParam = searchParams.get('tab');
  useEffect(() => {
    if (!tabParam || !ALL_REPORT_VALUES.has(tabParam)) return;
    setActiveReport(tabParam);
    setActiveCategory(categoryFor(tabParam));
  }, [tabParam]);

  function selectCategory(category: string) {
    setActiveCategory(category);
    const firstReport = REPORT_GROUPS.find((g) => g.category === category)?.reports[0]?.value;
    if (firstReport) setActiveReport(firstReport);
  }

  const [refreshDisabled, setRefreshDisabled] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [drilldownRow, setDrilldownRow] = useState<DailySalesReportRow | null>(null);
  const [discountDrilldownRow, setDiscountDrilldownRow] = useState<DiscountComplianceReportRow | null>(null);
  const [discountTypeFilter, setDiscountTypeFilter] = useState(ALL_DISCOUNT_TYPES);
  const [movementProofRow, setMovementProofRow] = useState<InventoryMovementReportRow | null>(null);
  const [selectedExpenseId, setSelectedExpenseId] = useState<string | null>(null);

  const requestExport = useRequestExport();

  useReportsRealtimeSync((payload: ExportReadyPayload) => {
    if (payload.requester_id !== currentUserId) return;
    toast.success('Export ready', {
      description: `Your ${reportTypeDisplayName(payload.report_type)} export is ready`,
      action: { label: 'Download', onClick: () => window.open(payload.download_url, '_blank') },
      duration: 30_000,
    });
    if (payload.format === 'csv') setIsExportingCsv(false);
    else setIsExportingPdf(false);
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

  const realtimeFilters = { branch_id: selectedBranchId ?? undefined, date_from: dateFrom, date_to: dateTo, page: 1, limit: 100 };

  const dailySales = useDailySalesReport(realtimeFilters, activeReport === 'DAILY_SALES');
  const voidRefund = useVoidRefundReport(realtimeFilters, activeReport === 'VOID_REFUND');
  const discountCompliance = useDiscountComplianceReport(realtimeFilters, activeReport === 'DISCOUNT_COMPLIANCE');
  // POS-PERF-P59 — the choices come from the unfiltered rows; the KPIs, table and export all follow the same discount identity.
  const discountRows = useMemo(() => mergeDiscountRows(discountCompliance.data?.data ?? []), [discountCompliance.data]);
  const discountOptions = useMemo(() => discountTypeOptions(discountRows), [discountRows]);
  const activeDiscountKey = discountTypeFilter === ALL_DISCOUNT_TYPES ? undefined : discountTypeFilter;
  const visibleDiscountRows = activeDiscountKey ? discountRows.filter((r) => r.discount_key === activeDiscountKey) : discountRows;
  // A chosen type can drop out when the branch or dates change: back to all types rather than an empty report.
  useEffect(() => {
    if (activeDiscountKey && discountCompliance.data && !discountRows.some((r) => r.discount_key === activeDiscountKey)) setDiscountTypeFilter(ALL_DISCOUNT_TYPES);
  }, [activeDiscountKey, discountCompliance.data, discountRows]);
  const discountColumns = useMemo(() => getDiscountBreakdownColumns({ showBranch: true, showProof: true, onViewTransactions: setDiscountDrilldownRow }), []);
  const inventoryMovement = useInventoryMovementReport(realtimeFilters, activeReport === 'INVENTORY_MOVEMENT');
  const inventorySummary = useInventorySummaryReport(realtimeFilters, activeReport === 'INVENTORY_SUMMARY');
  const attendanceSummary = useAttendanceSummaryReport(realtimeFilters, activeReport === 'ATTENDANCE_SUMMARY');
  const [expensesPage, setExpensesPage] = useState(1);
  // Dates or branch changing starts the list over, so a later page can't read as empty.
  useEffect(() => setExpensesPage(1), [selectedBranchId, dateFrom, dateTo]);
  const expenses = useExpenses({
    branch_id: selectedBranchId ?? undefined,
    date_from: dateFrom,
    date_to: dateTo,
    page: expensesPage,
    limit: EXPENSES_PAGE_SIZE,
  });
  const expenseColumns = useMemo(() => createExpenseColumns((row) => setSelectedExpenseId(row.id)), []);
  // Stable so opening/closing the transactions panel doesn't remount View Transactions, which the panel returns focus to.
  const dailySalesColumns = useMemo(() => getDailySalesColumns(setDrilldownRow), []);
  const selectedExpense = expenses.data?.expenses.find((row) => row.id === selectedExpenseId) ?? null;
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

  /** Broad invalidate rather than a single per-tab refetch — Refresh now needs to cover Financial Summary and Inventory Analytics panels too, which own their queries internally. Already rate-limited by the cooldown below. */
  function handleRefresh() {
    void queryClient.invalidateQueries({ queryKey: ['reports'] });
    void queryClient.invalidateQueries({ queryKey: ['expenses', 'list'] });
    setRefreshDisabled(true);
    setRefreshCooldown(REFRESH_COOLDOWN_SECONDS);
  }

  /** Financial Summary exports as the DAILY_SALES report (its underlying data source); Inventory Analytics has no registered ReportType and isn't exportable via this endpoint. Expenses is handled by handleExportExpenses below (CSV stays client-side, PDF now goes through requestExport). */
  function exportableReportType(): ExportRequestInput['report_type'] | null {
    if (activeReport === 'FINANCIAL_SUMMARY') return 'DAILY_SALES';
    if (activeReport === 'INVENTORY_ANALYTICS') return null;
    if (activeReport === 'EXPENSES') return null;
    // Extra Supplies exports its own filtered CSV from inside the history; Attendance Records has no export of its own
    // (Attendance Summary is the exportable attendance report). Neither has a report_type here.
    if (activeReport === EXTRA_SUPPLIES_REPORT_TAB || activeReport === ATTENDANCE_RECORDS_REPORT_TAB) return null;
    return activeReport as ExportRequestInput['report_type'];
  }

  // These views carry their own branch/date (and item/cashier, or supervisor/employee) filters; the page-level
  // bar would show filters and exports that do not apply to them, so it is hidden on those tabs.
  const showPageFilterBar = activeReport !== EXTRA_SUPPLIES_REPORT_TAB && activeReport !== ATTENDANCE_RECORDS_REPORT_TAB;
  const exportBranchRequired = BRANCH_REQUIRED_REPORTS.has(activeReport) && !selectedBranchId;

  /**
   * POS-PERF-P60 — both formats go through the same requestExport() mutation
   * every other report tab uses (report_type 'EXPENSES'), which re-fetches the
   * identical branch/date-filtered rows server-side (expensesRepository.findAll,
   * the same query behind this tab's screen) rather than recomputing anything.
   * A browser-built CSV only ever held the rows on screen. See
   * reports.service.ts's EXPENSES branch.
   */
  function handleExportExpenses(format: 'csv' | 'pdf') {
    const setIsExporting = format === 'csv' ? setIsExportingCsv : setIsExportingPdf;
    setIsExporting(true);
    requestExport.mutate(
      {
        report_type: 'EXPENSES',
        filters: { branch_id: selectedBranchId ?? undefined, date_from: dateFrom, date_to: dateTo, page: 1, limit: 100 },
        format,
      },
      { onSettled: () => setIsExporting(false) },
    );
  }

  function handleExport(format: 'csv' | 'pdf') {
    if (BRANCH_REQUIRED_REPORTS.has(activeReport) && !selectedBranchId) {
      toast.error('Select a branch before exporting');
      return;
    }
    if (activeReport === 'EXPENSES') {
      handleExportExpenses(format);
      return;
    }
    const reportType = exportableReportType();
    if (!reportType) return;
    const setIsExporting = format === 'csv' ? setIsExportingCsv : setIsExportingPdf;
    setIsExporting(true);
    const input: ExportRequestInput = {
      report_type: reportType,
      filters: {
        branch_id: selectedBranchId ?? undefined,
        date_from: dateFrom,
        date_to: dateTo,
        page: 1,
        limit: 100,
        ...(reportType === 'DISCOUNT_COMPLIANCE' && activeDiscountKey ? { discount_key: activeDiscountKey } : {}),
      },
      format,
    };
    requestExport.mutate(input, { onSettled: () => setIsExporting(false) });
  }

  return (
    <div className="app-section app-section-gap">
      <div className="min-w-0">
        <h1 className="app-title font-semibold">Reports</h1>
        <p className="app-subtitle text-muted-foreground">Real-time and pre-computed reporting across all branches.</p>
      </div>
      <ReportsSectionTabs basePath="/admin/reports" />

      {showPageFilterBar && (
        <ReportFilterBar
          branchId={selectedBranchId}
          onBranchChange={setSelectedBranchId}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
          onRefresh={handleRefresh}
          onExportCsv={() => handleExport('csv')}
          onExportPdf={() => handleExport('pdf')}
          isRefreshDisabled={refreshDisabled}
          refreshCooldownSeconds={refreshCooldown}
          isExportingCsv={isExportingCsv}
          isExportingPdf={isExportingPdf}
          exportDisabled={exportBranchRequired}
          showBranchSelector
        />
      )}

      <div role="group" aria-label="Report categories" className="flex flex-wrap gap-2 border-b pb-3">
        {REPORT_GROUPS.map((group) => (
          <button
            key={group.category}
            type="button"
            aria-pressed={activeCategory === group.category}
            onClick={() => selectCategory(group.category)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeCategory === group.category
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {group.category}
          </button>
        ))}
      </div>

      <Tabs value={activeReport} onValueChange={setActiveReport}>
        <TabsList>
          {REPORT_GROUPS.find((g) => g.category === activeCategory)?.reports.map((r) => (
            <TabsTrigger key={r.value} value={r.value}>
              {r.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="FINANCIAL_SUMMARY">
          <WidgetErrorBoundary label="Financial Summary">
            <FinancialSummaryPanel branchId={selectedBranchId} dateFrom={dateFrom} dateTo={dateTo} />
          </WidgetErrorBoundary>
        </TabsContent>

        <TabsContent value="INVENTORY_ANALYTICS">
          <WidgetErrorBoundary label="Inventory Analytics">
            <InventoryAnalyticsPanel branchId={selectedBranchId} />
          </WidgetErrorBoundary>
        </TabsContent>

            <TabsContent value="DAILY_SALES">
              {!selectedBranchId ? (
                <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
              ) : dailySales.isError ? <ErrorState retry={() => dailySales.refetch()} /> : <>
              <ReportLastUpdated timestamp={dailySales.data?.generated_at} isLoading={dailySales.isLoading} />
              <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-4">
                <KpiCard
                  title="Gross Sales — Selected Period"
                  value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.gross_sales, 0)}
                  prefix="₱"
                  isLoading={dailySales.isLoading}
                  tooltip={`Completed sales from ${dateFrom} to ${dateTo}.`}
                />
                <KpiCard title="Completed" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.completed_count, 0)} isLoading={dailySales.isLoading} />
                <KpiCard title="Voided" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.voided_count, 0)} isLoading={dailySales.isLoading} tone="warning" />
                <KpiCard title="Refunded" value={(dailySales.data?.data ?? []).reduce((sum, r) => sum + r.refunded_count, 0)} isLoading={dailySales.isLoading} tone="warning" />
              </div>
              <DataTable
                stickyHeader
                columns={dailySalesColumns}
                data={dailySales.data?.data ?? []}
                isLoading={dailySales.isLoading}
                emptyState={<EmptyState title="No sales in this range" />}
              />
              </>}
            </TabsContent>

            <TabsContent value="EXPENSES">
              {expenses.isError ? <ErrorState retry={() => expenses.refetch()} /> : <>
              <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <KpiCard title="Expenses" value={expenses.data?.total ?? 0} isLoading={expenses.isLoading} />
                <KpiCard title="Total Amount" value={expenses.data?.total_amount ?? 0} isLoading={expenses.isLoading} />
              </div>
              <div className="mb-4">
                <ExtraSupplySummaryCard title="Extra Supplies" branchId={selectedBranchId ?? undefined} dateFrom={dateFrom} dateTo={dateTo} historyPath={`/admin/reports?tab=${EXTRA_SUPPLIES_REPORT_TAB}`} />
                <ExpenseBreakdownCard
                  title="Expenses by Type"
                  branchId={selectedBranchId ?? undefined}
                  dateFrom={dateFrom}
                  dateTo={dateTo}
                  ledgerPath="/admin/expenses"
                  enabled={activeReport === 'EXPENSES'}
                />
              </div>
              <DataTable
                stickyHeader
                columns={expenseColumns}
                data={expenses.data?.expenses ?? []}
                isLoading={expenses.isLoading}
                pagination={{ pageIndex: expensesPage - 1, pageSize: EXPENSES_PAGE_SIZE }}
                onPaginationChange={(next) => setExpensesPage(next.pageIndex + 1)}
                rowCount={expenses.data?.total ?? 0}
                emptyState={
                  <EmptyState
                    title="No expenses recorded"
                    description="Expenses are submitted by branch supervisors and appear here automatically."
                  />
                }
              />
              </>}
            </TabsContent>

            <TabsContent value="VOID_REFUND">
              {!selectedBranchId ? (
                <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
              ) : voidRefund.isError ? <ErrorState retry={() => voidRefund.refetch()} /> : <>
              <ReportLastUpdated timestamp={voidRefund.data?.generated_at} isLoading={voidRefund.isLoading} />
              <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
                <KpiCard title="Voided" value={(voidRefund.data?.data ?? []).filter((r) => r.status === 'voided').length} isLoading={voidRefund.isLoading} />
                <KpiCard title="Refunded" value={(voidRefund.data?.data ?? []).filter((r) => r.status === 'refunded').length} isLoading={voidRefund.isLoading} />
                <KpiCard title="Total Amount" value={(voidRefund.data?.data ?? []).reduce((sum, r) => sum + r.total_amount, 0)} isLoading={voidRefund.isLoading} tone="warning" />
              </div>
              <DataTable
                stickyHeader
                columns={voidRefundColumns}
                data={voidRefund.data?.data ?? []}
                isLoading={voidRefund.isLoading}
                emptyState={<EmptyState title="No voids or refunds in this range" />}
              />
              </>}
            </TabsContent>

            <TabsContent value="DISCOUNT_COMPLIANCE">
              {!selectedBranchId ? (
                <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
              ) : discountCompliance.isError ? <ErrorState retry={() => discountCompliance.refetch()} /> : <>
              <ReportLastUpdated timestamp={discountCompliance.data?.generated_at} isLoading={discountCompliance.isLoading} />
              <div className="my-4 space-y-4">
                <DiscountTypeFilter options={discountOptions} value={discountTypeFilter} onChange={setDiscountTypeFilter} />
                {discountCompliance.data && (
                  <DiscountCoverageNotice
                    rowsReturned={discountCompliance.data.data.length}
                    rowsTotal={discountCompliance.data.total}
                    transactionCount={visibleDiscountRows.reduce((sum, r) => sum + r.transaction_count, 0)}
                  />
                )}
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <KpiCard
                    title="Total Discounted Transactions"
                    value={visibleDiscountRows.reduce((sum, r) => sum + r.transaction_count, 0)}
                    isLoading={discountCompliance.isLoading}
                  />
                  <KpiCard
                    title="Total Discount Amount"
                    value={visibleDiscountRows.reduce((sum, r) => sum + r.total_discount_amount, 0)}
                    prefix="₱"
                    isLoading={discountCompliance.isLoading}
                    tone="warning"
                  />
                </div>
                <DiscountProofSummary summary={summarizeDiscountProof(visibleDiscountRows)} isLoading={discountCompliance.isLoading} />
              </div>
              <DataTable
                stickyHeader
                columns={discountColumns}
                data={visibleDiscountRows}
                isLoading={discountCompliance.isLoading}
                emptyState={<EmptyState title="No discounted transactions in this range" />}
              />
              </>}
            </TabsContent>

            <TabsContent value="INVENTORY_MOVEMENT">
              {!selectedBranchId ? (
                <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
              ) : inventoryMovement.isError ? <ErrorState retry={() => inventoryMovement.refetch()} /> : <>
              <ReportLastUpdated timestamp={inventoryMovement.data?.generated_at} isLoading={inventoryMovement.isLoading} />
              <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
                <KpiCard title="Total Movements" value={(inventoryMovement.data?.data ?? []).length} isLoading={inventoryMovement.isLoading} />
                <KpiCard
                  title="Deliveries / Received"
                  value={(inventoryMovement.data?.data ?? []).filter((r) => r.movement_type === 'RECEIVING').length}
                  isLoading={inventoryMovement.isLoading}
                />
                <KpiCard
                  title="Waste"
                  value={(inventoryMovement.data?.data ?? []).filter((r) => r.movement_type === 'WASTE').length}
                  isLoading={inventoryMovement.isLoading}
                  tone="warning"
                />
              </div>
              <DataTable
                stickyHeader
                columns={createInventoryMovementColumns(setMovementProofRow)}
                data={inventoryMovement.data?.data ?? []}
                isLoading={inventoryMovement.isLoading}
                emptyState={<EmptyState title="No inventory movements in this range" />}
              />
              </>}
            </TabsContent>

            <TabsContent value="INVENTORY_SUMMARY">
              {!selectedBranchId ? (
                <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
              ) : inventorySummary.isError ? <ErrorState retry={() => inventorySummary.refetch()} /> : <>
              <ReportLastUpdated timestamp={inventorySummary.data?.generated_at} isLoading={inventorySummary.isLoading} />
              {(() => {
                const ingredientWeightKg = inventorySummary.data?.ingredient_weight_kg ?? [];
                const packagingPc = inventorySummary.data?.packaging_pc ?? [];
                const excludedCount = inventorySummary.data?.excluded_ingredient_count ?? 0;
                return (
                  <>
                    <h3 className="mt-6 mb-2 text-sm font-semibold text-foreground">Ingredient Stock Used (KG)</h3>
                    {!isDesktop && !inventorySummary.isLoading && ingredientWeightKg.length > 0 ? (
                      <IngredientWeightKgMobileCards rows={ingredientWeightKg} />
                    ) : (
                      <DataTable
                        stickyHeader
                        columns={ingredientWeightKgColumns}
                        data={ingredientWeightKg}
                        isLoading={inventorySummary.isLoading}
                        emptyState={<EmptyState title="No weighable ingredients" description="No KG-convertible ingredients at this branch." />}
                      />
                    )}
                    {excludedCount > 0 && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        Some ingredients have no weight conversion configured — shown in native units only, excluded from the KG totals.
                      </p>
                    )}

                    <h3 className="mt-6 mb-2 text-sm font-semibold text-foreground">Packaging Stock Used (PC)</h3>
                    {!isDesktop && !inventorySummary.isLoading && packagingPc.length > 0 ? (
                      <PackagingPcMobileCards rows={packagingPc} />
                    ) : (
                      <DataTable
                        stickyHeader
                        columns={packagingPcColumns}
                        data={packagingPc}
                        isLoading={inventorySummary.isLoading}
                        emptyState={<EmptyState title="No packaging items" description="No packaging items at this branch." />}
                      />
                    )}
                  </>
                );
              })()}
              </>}
            </TabsContent>

            <TabsContent value="ATTENDANCE_SUMMARY">
              {!selectedBranchId ? (
                <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
              ) : attendanceSummary.isError ? <ErrorState retry={() => attendanceSummary.refetch()} /> : <>
              <ReportLastUpdated timestamp={attendanceSummary.data?.generated_at} isLoading={attendanceSummary.isLoading} />
              <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <KpiCard title="Attendance Records" value={(attendanceSummary.data?.data ?? []).length} isLoading={attendanceSummary.isLoading} />
                <KpiCard
                  title="Corrected"
                  value={(attendanceSummary.data?.data ?? []).filter((r) => r.status === 'corrected').length}
                  isLoading={attendanceSummary.isLoading}
                  tone="warning"
                />
              </div>
              <DataTable
                stickyHeader
                columns={attendanceSummaryColumns}
                data={attendanceSummary.data?.data ?? []}
                isLoading={attendanceSummary.isLoading}
                emptyState={<EmptyState title="No attendance records in this range" />}
              />
              </>}
            </TabsContent>

            <TabsContent value={ATTENDANCE_RECORDS_REPORT_TAB}>
              <WidgetErrorBoundary label="Attendance Records">
                <AdminAttendanceReport />
              </WidgetErrorBoundary>
            </TabsContent>

            <TabsContent value={EXTRA_SUPPLIES_REPORT_TAB}>
              {/* History reads a drill-through link's filters, which needs a Suspense boundary. */}
              <Suspense fallback={null}>
                <ExtraSupplyHistory />
              </Suspense>
            </TabsContent>

      </Tabs>

      <DailySalesDrilldown
        open={drilldownRow !== null}
        onOpenChange={(o) => !o && setDrilldownRow(null)}
        branchId={drilldownRow?.branch_id ?? null}
        branchName={drilldownRow?.branch_name ?? ''}
        reportDate={drilldownRow?.report_date ?? ''}
      />

      <DiscountComplianceDrilldown
        open={discountDrilldownRow !== null}
        onOpenChange={(o) => !o && setDiscountDrilldownRow(null)}
        branchId={discountDrilldownRow?.branch_id ?? null}
        branchName={discountDrilldownRow?.branch_name ?? ''}
        discountType={discountDrilldownRow?.discount_type ?? null}
        discountKey={discountDrilldownRow?.discount_key ?? null}
        discountName={discountDrilldownRow?.discount_name ?? null}
        dateFrom={dateFrom}
        dateTo={dateTo}
      />

      <ViewInventoryMovementProofDialog
        branchId={movementProofRow?.branch_id ?? null}
        movementId={movementProofRow?.movement_id ?? null}
        onOpenChange={(o) => !o && setMovementProofRow(null)}
      />

      <ViewExpenseReceiptDialog
        expense={selectedExpenseReceipt}
        onOpenChange={(o) => !o && setSelectedExpenseId(null)}
        onRetry={() => void expenses.refetch()}
      />
    </div>
  );
}

export default function AdminReportsPage() {
  return (
    <Suspense fallback={<div>Loading reports...</div>}>
      <AdminReportsPageContent />
    </Suspense>
  );
}
