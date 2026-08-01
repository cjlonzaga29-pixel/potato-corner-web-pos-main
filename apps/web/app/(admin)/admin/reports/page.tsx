'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { toast } from 'sonner';
import type {
  DailySalesReportRow,
  CashReconciliationReportRow,
  VoidRefundReportRow,
  DiscountComplianceReportRow,
  InventoryMovementReportRow,
  InventoryConsumptionSummaryReportRow,
  InventorySummaryReportRow,
  AttendanceSummaryReportRow,
  FraudAlertSummaryReportRow,
  TransactionResponse,
  ExportReadyPayload,
  ExportRequestInput,
} from '@potato-corner/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusBadge } from '@/components/shared/status-badge';
import { ReportFilterBar } from '@/components/reports/report-filter-bar';
import { ReportLastUpdated } from '@/components/reports/report-last-updated';
import { DailySalesDrilldown } from '@/components/reports/daily-sales-drilldown';
import { FraudAlertManagementPanel } from '@/components/reports/fraud-alert-management-panel';
import { ShiftLogPanel } from '@/components/reports/shift-log-panel';
import { LoginAuditPanel } from '@/components/reports/login-audit-panel';
import { FinancialSummaryPanel } from '@/components/reports/financial-summary-panel';
import { InventoryAnalyticsPanel } from '@/components/reports/inventory-analytics-panel';
import { WidgetErrorBoundary } from '@/components/shared/widget-error-boundary';
import { expenseColumns } from '@/components/admin/expense-columns';
import { ReceiptModal } from '@/components/pos/receipt-modal';
import { ViewPaymentProofDialog } from '@/components/shared/transactions/view-payment-proof-dialog';
import { ViewTransactionItemsDialog } from '@/components/shared/transactions/view-transaction-items-dialog';
import { ViewTransactionDetailDialog } from '@/components/shared/transactions/view-transaction-detail-dialog';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { manilaToday, manilaDaysAgo } from '@/lib/manila-date';
import { useAuthStore } from '@/stores/auth.store';
import { useSocketStore } from '@/stores/socket.store';
import { useExpenses, useExpensesRealtimeSync } from '@/hooks/queries/use-expenses';
import { useTransactions, useTransaction } from '@/hooks/queries/use-transactions';
import { useEmployees } from '@/hooks/queries/use-employees';
import { useBranch } from '@/hooks/queries/use-branches';
import {
  useDailySalesReport,
  useCashReconciliationReport,
  useVoidRefundReport,
  useDiscountComplianceReport,
  useInventoryMovementReport,
  useInventoryConsumptionSummaryReport,
  useInventorySummaryReport,
  useAttendanceSummaryReport,
  useFraudAlertSummaryReport,
  useRequestExport,
  useReportsRealtimeSync,
  useReportsTrendsRealtimeSync,
  useInventoryAnalyticsRealtimeSync,
} from '@/hooks/queries/use-reports';

const REFRESH_COOLDOWN_SECONDS = 60;
const DEFAULT_RANGE_DAYS = 7;

function humanize(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Mirrors the fallback severity treatment in fraud-alert-columns.tsx — StatusBadge has no severity map. */
const REPORT_SEVERITY_CLASSES: Record<string, string> = {
  critical: 'border-transparent bg-destructive/15 text-destructive',
  high: 'border-transparent bg-warning/15 text-warning',
  medium: 'border-transparent bg-accent/15 text-accent',
  low: 'border-transparent bg-info/15 text-info',
};

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

const cashReconciliationColumns: ColumnDef<CashReconciliationReportRow>[] = [
  { accessorKey: 'cashier_name', header: 'Cashier' },
  { accessorKey: 'branch_name', header: 'Branch' },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} type="shift" />,
  },
  { accessorKey: 'opening_counted_total', header: 'Opening', cell: ({ row }) => formatCurrency(row.original.opening_counted_total) },
  {
    accessorKey: 'closing_counted_total',
    header: 'Closing',
    cell: ({ row }) => (row.original.closing_counted_total !== null ? formatCurrency(row.original.closing_counted_total) : '—'),
  },
  {
    accessorKey: 'cash_variance',
    header: 'Variance',
    cell: ({ row }) => (row.original.cash_variance !== null ? formatCurrency(row.original.cash_variance) : '—'),
  },
  {
    accessorKey: 'variance_approved',
    header: 'Approved',
    cell: ({ row }) => (row.original.variance_approved === null ? '—' : row.original.variance_approved ? 'Yes' : 'No'),
  },
];

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

const fraudAlertSummaryColumns: ColumnDef<FraudAlertSummaryReportRow>[] = [
  { accessorKey: 'alert_type', header: 'Type' },
  {
    id: 'severity',
    header: 'Severity',
    cell: ({ row }) => (
      <Badge className={REPORT_SEVERITY_CLASSES[row.original.severity] ?? undefined}>
        {humanize(row.original.severity)}
      </Badge>
    ),
  },
  { accessorKey: 'branch_name', header: 'Branch', cell: ({ row }) => row.original.branch_name ?? 'All Branches' },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} type="fraud" />,
  },
  { accessorKey: 'created_at', header: 'Created', cell: ({ row }) => formatDateTime(row.original.created_at) },
];

const discountComplianceColumns: ColumnDef<DiscountComplianceReportRow>[] = [
  { accessorKey: 'branch_name', header: 'Branch' },
  { id: 'discount_type', header: 'Discount Type', cell: ({ row }) => humanize(row.original.discount_type) },
  { accessorKey: 'transaction_count', header: 'Transactions' },
  {
    accessorKey: 'total_discount_amount',
    header: 'Discount Amount',
    cell: ({ row }) => formatCurrency(row.original.total_discount_amount),
  },
  {
    accessorKey: 'total_vat_exempt_amount',
    header: 'VAT Exempt Amount',
    cell: ({ row }) => formatCurrency(row.original.total_vat_exempt_amount),
  },
];

const inventoryMovementColumns: ColumnDef<InventoryMovementReportRow>[] = [
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'ingredient_name', header: 'Ingredient' },
  { id: 'movement_type', header: 'Type', cell: ({ row }) => humanize(row.original.movement_type) },
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
  { accessorKey: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
];

const inventoryConsumptionSummaryColumns: ColumnDef<InventoryConsumptionSummaryReportRow>[] = [
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'ingredient_name', header: 'Ingredient' },
  {
    id: 'quantity_consumed',
    header: 'Consumed',
    cell: ({ row }) => `${row.original.quantity_consumed} ${row.original.unit}`,
  },
  {
    accessorKey: 'unit_cost',
    header: 'Unit Cost',
    cell: ({ row }) => (row.original.unit_cost !== null ? formatCurrency(row.original.unit_cost) : '—'),
  },
  { accessorKey: 'consumption_value', header: 'Consumption Value', cell: ({ row }) => formatCurrency(row.original.consumption_value) },
  { accessorKey: 'movement_count', header: 'Sales Movements' },
];

const inventorySummaryColumns: ColumnDef<InventorySummaryReportRow>[] = [
  { accessorKey: 'branch_name', header: 'Branch' },
  { accessorKey: 'ingredient_name', header: 'Ingredient' },
  { id: 'opening_stock', header: 'Opening Stock', cell: ({ row }) => `${row.original.opening_stock} ${row.original.unit}` },
  { id: 'consumed_today', header: 'Consumed Today', cell: ({ row }) => `${row.original.consumed_today} ${row.original.unit}` },
  { id: 'consumed_this_month', header: 'Consumed This Month', cell: ({ row }) => `${row.original.consumed_this_month} ${row.original.unit}` },
  { id: 'remaining_stock', header: 'Remaining', cell: ({ row }) => `${row.original.remaining_stock} ${row.original.unit}` },
  {
    id: 'remaining_conversion',
    header: 'Remaining (g / kg)',
    cell: ({ row }) =>
      row.original.remaining_grams !== null && row.original.remaining_kilograms !== null
        ? `${row.original.remaining_grams} g / ${row.original.remaining_kilograms} kg`
        : '—',
  },
];

/** Mirrors reports-view.tsx's getSoldProductTransactionsColumns (Branch/Supervisor) — one row per transaction, not per product line, so Subtotal/VAT/Discount/Total are never duplicated. */
function getSoldProductTransactionsColumns(
  branchName: string,
  employeeNames: Map<string, string>,
  onViewItems: (transaction: TransactionResponse) => void,
  onViewTransaction: (transaction: TransactionResponse) => void,
  onViewReceipt: (transactionId: string) => void,
  onViewProof: (transactionId: string) => void,
): ColumnDef<TransactionResponse>[] {
  return [
    { id: 'created_at', header: 'Date and Time', cell: ({ row }) => formatDateTime(row.original.created_at) },
    { id: 'receipt_number', header: 'Receipt #', accessorKey: 'receipt_number' },
    { id: 'branch', header: 'Branch', cell: () => branchName },
    {
      id: 'cashier',
      header: 'Cashier',
      cell: ({ row }) => employeeNames.get(row.original.cashier_id) ?? row.original.cashier_id,
    },
    {
      id: 'items',
      header: 'Products',
      cell: ({ row }) => {
        const items = row.original.items ?? [];
        const firstItem = items[0];
        const summary =
          items.length === 0 || !firstItem
            ? 'No items'
            : items.length === 1
              ? `${firstItem.quantity}x ${firstItem.product_name}`
              : `${items.length} items`;
        return (
          <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-xs underline" onClick={() => onViewItems(row.original)}>
            {summary}
          </Button>
        );
      },
    },
    { id: 'subtotal', header: 'Subtotal', cell: ({ row }) => formatCurrency(row.original.subtotal) },
    { id: 'vat_amount', header: 'VAT', cell: ({ row }) => formatCurrency(row.original.vat_amount) },
    { id: 'discount_amount', header: 'Discount', cell: ({ row }) => formatCurrency(row.original.discount_amount) },
    { id: 'total_amount', header: 'Total', cell: ({ row }) => formatCurrency(row.original.total_amount) },
    {
      id: 'payment_method',
      header: 'Payment Method',
      cell: ({ row }) => <Badge variant="outline">{humanize(row.original.payment_method)}</Badge>,
    },
    { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} type="transaction" /> },
    {
      id: 'payment_proof',
      header: 'Payment Proof',
      cell: ({ row }) => {
        const txn = row.original;
        if (txn.payment_method === 'cash') return <span className="text-xs text-muted-foreground">Not required</span>;
        if (!txn.has_payment_proof) return <span className="text-xs text-muted-foreground">Missing</span>;
        return (
          <Button type="button" variant="ghost" size="sm" onClick={() => onViewProof(txn.id)}>
            Available
          </Button>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onViewTransaction(row.original)}>
            View Transaction
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onViewReceipt(row.original.id)}>
            View Receipt
          </Button>
        </div>
      ),
    },
  ];
}

const attendanceSummaryColumns: ColumnDef<AttendanceSummaryReportRow>[] = [
  { accessorKey: 'employee_name', header: 'Employee' },
  { accessorKey: 'branch_name', header: 'Branch' },
  { id: 'clock_in', header: 'Clock In', cell: ({ row }) => formatDateTime(row.original.clock_in) },
  {
    id: 'clock_out',
    header: 'Clock Out',
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
      { value: 'DAILY_SALES', label: 'Daily Sales' },
      { value: 'SOLD_PRODUCT_TRANSACTIONS', label: 'Sold Product Transactions' },
      { value: 'CASH_RECONCILIATION', label: 'Cash Reconciliation' },
      { value: 'EXPENSES', label: 'Expenses' },
    ],
  },
  {
    category: 'Inventory',
    reports: [
      { value: 'INVENTORY_ANALYTICS', label: 'Inventory Analytics' },
      { value: 'INVENTORY_MOVEMENT', label: 'Inventory Movement' },
      { value: 'INVENTORY_CONSUMPTION_SUMMARY', label: 'Consumption Summary' },
      { value: 'INVENTORY_SUMMARY', label: 'Inventory Summary' },
    ],
  },
  {
    category: 'Operations',
    reports: [
      { value: 'SHIFT_SUMMARY', label: 'Shift Reports' },
      { value: 'ATTENDANCE_SUMMARY', label: 'Attendance Summary' },
    ],
  },
  {
    category: 'Compliance',
    reports: [
      { value: 'VOID_REFUND', label: 'Void / Refund' },
      { value: 'FRAUD_ALERT_SUMMARY', label: 'Alerts' },
      { value: 'DISCOUNT_COMPLIANCE', label: 'Discount Compliance' },
      { value: 'AUDIT_LOG', label: 'Audit Log' },
    ],
  },
];

const ALL_REPORT_VALUES = new Set(REPORT_GROUPS.flatMap((g) => g.reports.map((r) => r.value)));

/** Mirrors the `!selectedBranchId` gate already on each of these tabs' "Select a branch" empty state below — kept as one set so the export controls stay in sync with the on-screen gate instead of drifting from it. */
const BRANCH_REQUIRED_REPORTS = new Set([
  'DAILY_SALES',
  'SOLD_PRODUCT_TRANSACTIONS',
  'CASH_RECONCILIATION',
  'VOID_REFUND',
  'DISCOUNT_COMPLIANCE',
  'INVENTORY_MOVEMENT',
  'INVENTORY_CONSUMPTION_SUMMARY',
  'INVENTORY_SUMMARY',
  'ATTENDANCE_SUMMARY',
]);

function categoryFor(reportValue: string): string {
  return REPORT_GROUPS.find((g) => g.reports.some((r) => r.value === reportValue))?.category ?? 'Finance';
}

function AdminReportsPageContent() {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isSocketConnected = useSocketStore((s) => s.isConnected);
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

  // Sold Product Transactions filters (client-side over the fetched page) —
  // mirrors reports-view.tsx's (Branch/Supervisor) same-named state.
  const [soldReceiptSearch, setSoldReceiptSearch] = useState('');
  const [soldCashierFilter, setSoldCashierFilter] = useState('all');
  const [soldPaymentMethodFilter, setSoldPaymentMethodFilter] = useState('all');
  const [soldStatusFilter, setSoldStatusFilter] = useState('all');
  const [soldProductFilter, setSoldProductFilter] = useState('all');
  const [soldPagination, setSoldPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [receiptTransactionId, setReceiptTransactionId] = useState<string | null>(null);
  const [proofTransactionId, setProofTransactionId] = useState<string | null>(null);
  const [viewItemsTransaction, setViewItemsTransaction] = useState<TransactionResponse | null>(null);
  const [viewDetailTransaction, setViewDetailTransaction] = useState<TransactionResponse | null>(null);
  const { data: receiptTransaction } = useTransaction(receiptTransactionId);

  const requestExport = useRequestExport();

  useReportsRealtimeSync((payload: ExportReadyPayload) => {
    if (payload.requester_id !== currentUserId) return;
    toast.success('Export ready', {
      description: `Your ${payload.report_type} export is ready`,
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
  const cashReconciliation = useCashReconciliationReport(realtimeFilters, activeReport === 'CASH_RECONCILIATION');
  const voidRefund = useVoidRefundReport(realtimeFilters, activeReport === 'VOID_REFUND');
  const fraudAlertSummary = useFraudAlertSummaryReport(realtimeFilters, activeReport === 'FRAUD_ALERT_SUMMARY');
  const discountCompliance = useDiscountComplianceReport(realtimeFilters, activeReport === 'DISCOUNT_COMPLIANCE');
  const inventoryMovement = useInventoryMovementReport(realtimeFilters, activeReport === 'INVENTORY_MOVEMENT');
  const inventoryConsumptionSummary = useInventoryConsumptionSummaryReport(realtimeFilters, activeReport === 'INVENTORY_CONSUMPTION_SUMMARY');
  const inventorySummary = useInventorySummaryReport(realtimeFilters, activeReport === 'INVENTORY_SUMMARY');
  const attendanceSummary = useAttendanceSummaryReport(realtimeFilters, activeReport === 'ATTENDANCE_SUMMARY');
  // Sold Product Transactions — no realtime report endpoint exists for this
  // type (only the export pipeline's reportsRepository.getSoldProductTransactions),
  // so the on-screen table reuses the existing transactions list, same as
  // reports-view.tsx (Branch/Supervisor). Not status-filtered so the tab's
  // own Status filter can show voided/refunded rows too.
  const soldProductTransactionsQuery = useTransactions(
    activeReport === 'SOLD_PRODUCT_TRANSACTIONS' && selectedBranchId
      ? { branch_id: selectedBranchId, date_from: dateFrom, date_to: dateTo, limit: 100 }
      : {},
  );
  const soldProductEmployees = useEmployees(
    { branchId: selectedBranchId ?? undefined, limit: 100 },
    { enabled: activeReport === 'SOLD_PRODUCT_TRANSACTIONS' && Boolean(selectedBranchId) },
  );
  const soldProductBranch = useBranch(activeReport === 'SOLD_PRODUCT_TRANSACTIONS' ? selectedBranchId : null);
  const expenses = useExpenses({
    branch_id: selectedBranchId ?? undefined,
    date_from: dateFrom,
    date_to: dateTo,
    page: 1,
    limit: 100,
  });

  // Sold Product Transactions — client-side filtering/pagination over the
  // fetched page, same known 100-row ceiling as reports-view.tsx (none of
  // these are supported query params on GET /api/transactions today).
  const soldProductEmployeeNames = new Map((soldProductEmployees.data?.employees ?? []).map((e) => [e.id, `${e.first_name} ${e.last_name}`]));
  const soldProductTransactionsAll = soldProductTransactionsQuery.data?.transactions ?? [];
  const soldProductOptions = Array.from(
    new Set(soldProductTransactionsAll.flatMap((t) => (t.items ?? []).map((i) => i.product_name))),
  ).sort();
  const filteredSoldProductTransactions = soldProductTransactionsAll.filter((t) => {
    if (soldCashierFilter !== 'all' && t.cashier_id !== soldCashierFilter) return false;
    if (soldPaymentMethodFilter !== 'all' && t.payment_method !== soldPaymentMethodFilter) return false;
    if (soldStatusFilter !== 'all' && t.status !== soldStatusFilter) return false;
    if (soldProductFilter !== 'all' && !(t.items ?? []).some((i) => i.product_name === soldProductFilter)) return false;
    const search = soldReceiptSearch.trim().toLowerCase();
    if (search && !t.receipt_number.toLowerCase().includes(search)) return false;
    return true;
  });
  const soldProductTransactionsPageRows = filteredSoldProductTransactions.slice(
    soldPagination.pageIndex * soldPagination.pageSize,
    soldPagination.pageIndex * soldPagination.pageSize + soldPagination.pageSize,
  );

  /** Broad invalidate rather than a single per-tab refetch — Refresh now needs to cover Financial Summary and Inventory Analytics panels too, which own their queries internally. Already rate-limited by the cooldown below. */
  function handleRefresh() {
    void queryClient.invalidateQueries({ queryKey: ['reports'] });
    void queryClient.invalidateQueries({ queryKey: ['expenses', 'list'] });
    setRefreshDisabled(true);
    setRefreshCooldown(REFRESH_COOLDOWN_SECONDS);
  }

  /** Financial Summary exports as the DAILY_SALES report (its underlying data source); Inventory Analytics and Expenses have no registered ReportType and aren't exportable via this endpoint. */
  function exportableReportType(): ExportRequestInput['report_type'] | null {
    if (activeReport === 'FINANCIAL_SUMMARY') return 'DAILY_SALES';
    if (activeReport === 'INVENTORY_ANALYTICS') return null;
    if (activeReport === 'EXPENSES') return null;
    return activeReport as ExportRequestInput['report_type'];
  }

  const exportBranchRequired = BRANCH_REQUIRED_REPORTS.has(activeReport) && !selectedBranchId;

  function handleExport(format: 'csv' | 'pdf') {
    if (BRANCH_REQUIRED_REPORTS.has(activeReport) && !selectedBranchId) {
      toast.error('Select a branch before exporting');
      return;
    }
    const reportType = exportableReportType();
    if (!reportType) return;
    const setIsExporting = format === 'csv' ? setIsExportingCsv : setIsExportingPdf;
    setIsExporting(true);
    const baseFilters: ExportRequestInput['filters'] = { branch_id: selectedBranchId ?? undefined, date_from: dateFrom, date_to: dateTo, page: 1, limit: 100 };
    // Only the Sold Product Transactions tab has its own sub-filters —
    // forwarding them regardless of activeReport would silently narrow every
    // other tab's export by whatever was last typed into these controls.
    const filters: ExportRequestInput['filters'] =
      activeReport === 'SOLD_PRODUCT_TRANSACTIONS'
        ? {
            ...baseFilters,
            ...(soldCashierFilter !== 'all' && { cashier_id: soldCashierFilter }),
            ...(soldPaymentMethodFilter !== 'all' && { payment_method: soldPaymentMethodFilter as ExportRequestInput['filters']['payment_method'] }),
            ...(soldStatusFilter !== 'all' && { status: soldStatusFilter as ExportRequestInput['filters']['status'] }),
            ...(soldProductFilter !== 'all' && { product_name: soldProductFilter }),
            ...(soldReceiptSearch.trim() && { receipt_search: soldReceiptSearch.trim() }),
          }
        : baseFilters;
    const input: ExportRequestInput = {
      report_type: reportType,
      filters,
      format,
    };
    requestExport.mutate(input, { onSettled: () => setIsExporting(false) });
  }

  const connectionLabel = isSocketConnected ? 'Connected' : 'Disconnected';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Reports</h1>
          <p className="text-muted-foreground text-sm">Real-time and pre-computed reporting across all branches.</p>
        </div>
        <span
          title={connectionLabel}
          aria-label={connectionLabel}
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${isSocketConnected ? 'bg-success' : 'bg-destructive'}`}
        />
      </div>

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
        <TabsList className="flex-wrap">
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
                columns={getDailySalesColumns(setDrilldownRow)}
                data={dailySales.data?.data ?? []}
                isLoading={dailySales.isLoading}
                emptyState={<EmptyState title="No sales in this range" />}
              />
              </>}
            </TabsContent>

            <TabsContent value="SOLD_PRODUCT_TRANSACTIONS">
              {!selectedBranchId ? (
                <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
              ) : soldProductTransactionsQuery.isError ? (
                <ErrorState retry={() => soldProductTransactionsQuery.refetch()} />
              ) : (
                <>
                  <ReportLastUpdated
                    timestamp={soldProductTransactionsQuery.dataUpdatedAt ? new Date(soldProductTransactionsQuery.dataUpdatedAt).toISOString() : undefined}
                    isLoading={soldProductTransactionsQuery.isLoading}
                  />
                  <div className="my-4 flex flex-wrap items-end gap-3">
                    <div>
                      <Label htmlFor="sold-receipt-search">Receipt #</Label>
                      <Input
                        id="sold-receipt-search"
                        placeholder="Search receipt number"
                        className="w-[180px]"
                        value={soldReceiptSearch}
                        onChange={(e) => {
                          setSoldReceiptSearch(e.target.value);
                          setSoldPagination((p) => ({ ...p, pageIndex: 0 }));
                        }}
                      />
                    </div>
                    <div>
                      <Label>Cashier</Label>
                      <Select
                        value={soldCashierFilter}
                        onValueChange={(v) => {
                          setSoldCashierFilter(v);
                          setSoldPagination((p) => ({ ...p, pageIndex: 0 }));
                        }}
                      >
                        <SelectTrigger className="w-[160px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All cashiers</SelectItem>
                          {Array.from(soldProductEmployeeNames.entries()).map(([id, name]) => (
                            <SelectItem key={id} value={id}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Payment Method</Label>
                      <Select
                        value={soldPaymentMethodFilter}
                        onValueChange={(v) => {
                          setSoldPaymentMethodFilter(v);
                          setSoldPagination((p) => ({ ...p, pageIndex: 0 }));
                        }}
                      >
                        <SelectTrigger className="w-[150px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All methods</SelectItem>
                          <SelectItem value="cash">Cash</SelectItem>
                          <SelectItem value="gcash">GCash</SelectItem>
                          <SelectItem value="maya">Maya</SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Status</Label>
                      <Select
                        value={soldStatusFilter}
                        onValueChange={(v) => {
                          setSoldStatusFilter(v);
                          setSoldPagination((p) => ({ ...p, pageIndex: 0 }));
                        }}
                      >
                        <SelectTrigger className="w-[150px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All statuses</SelectItem>
                          <SelectItem value="completed">Completed</SelectItem>
                          <SelectItem value="voided">Voided</SelectItem>
                          <SelectItem value="refunded">Refunded</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Product</Label>
                      <Select
                        value={soldProductFilter}
                        onValueChange={(v) => {
                          setSoldProductFilter(v);
                          setSoldPagination((p) => ({ ...p, pageIndex: 0 }));
                        }}
                      >
                        <SelectTrigger className="w-[170px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All products</SelectItem>
                          {soldProductOptions.map((name) => (
                            <SelectItem key={name} value={name}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <DataTable
                    columns={getSoldProductTransactionsColumns(
                      soldProductBranch.data?.name ?? '—',
                      soldProductEmployeeNames,
                      setViewItemsTransaction,
                      setViewDetailTransaction,
                      setReceiptTransactionId,
                      setProofTransactionId,
                    )}
                    data={soldProductTransactionsPageRows}
                    isLoading={soldProductTransactionsQuery.isLoading}
                    pagination={soldPagination}
                    onPaginationChange={setSoldPagination}
                    rowCount={filteredSoldProductTransactions.length}
                    emptyState={<EmptyState title="No sold products" description="No product sales match these filters in this date range." />}
                  />
                </>
              )}
            </TabsContent>

            <TabsContent value="CASH_RECONCILIATION">
              {!selectedBranchId ? (
                <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
              ) : cashReconciliation.isError ? <ErrorState retry={() => cashReconciliation.refetch()} /> : <>
              <ReportLastUpdated timestamp={cashReconciliation.data?.generated_at} isLoading={cashReconciliation.isLoading} />
              <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
                <KpiCard title="Closed/Flagged Shifts" value={(cashReconciliation.data?.data ?? []).length} isLoading={cashReconciliation.isLoading} />
                <KpiCard
                  title="Flagged"
                  value={(cashReconciliation.data?.data ?? []).filter((r) => r.status === 'flagged').length}
                  isLoading={cashReconciliation.isLoading}
                  tone="danger"
                />
                <KpiCard
                  title="Unapproved Variance"
                  value={(cashReconciliation.data?.data ?? []).filter((r) => r.cash_variance !== null && r.cash_variance !== 0 && !r.variance_approved).length}
                  isLoading={cashReconciliation.isLoading}
                  tone="warning"
                />
              </div>
              <DataTable
                columns={cashReconciliationColumns}
                data={cashReconciliation.data?.data ?? []}
                isLoading={cashReconciliation.isLoading}
                emptyState={<EmptyState title="No closed or flagged shifts in this range" />}
              />
              </>}
            </TabsContent>

            <TabsContent value="EXPENSES">
              {expenses.isError ? <ErrorState retry={() => expenses.refetch()} /> : <>
              <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <KpiCard title="Expenses" value={expenses.data?.total ?? 0} isLoading={expenses.isLoading} />
                <KpiCard title="Total Amount" value={expenses.data?.total_amount ?? 0} isLoading={expenses.isLoading} />
              </div>
              <DataTable
                columns={expenseColumns}
                data={expenses.data?.expenses ?? []}
                isLoading={expenses.isLoading}
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
              <DataTable columns={voidRefundColumns} data={voidRefund.data?.data ?? []} isLoading={voidRefund.isLoading} emptyState={<EmptyState title="No voids or refunds in this range" />} />
              </>}
            </TabsContent>

            <TabsContent value="SHIFT_SUMMARY">
              <ShiftLogPanel />
            </TabsContent>

            <TabsContent value="FRAUD_ALERT_SUMMARY">
              {fraudAlertSummary.isError ? <ErrorState retry={() => fraudAlertSummary.refetch()} /> : <>
              <ReportLastUpdated timestamp={fraudAlertSummary.data?.generated_at} isLoading={fraudAlertSummary.isLoading} />
              <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <KpiCard title="Alerts" value={(fraudAlertSummary.data?.data ?? []).length} isLoading={fraudAlertSummary.isLoading} />
                <KpiCard
                  title="Critical/High"
                  value={(fraudAlertSummary.data?.data ?? []).filter((r) => r.severity === 'critical' || r.severity === 'high').length}
                  isLoading={fraudAlertSummary.isLoading}
                  tone="danger"
                />
              </div>
              <DataTable
                columns={fraudAlertSummaryColumns}
                data={fraudAlertSummary.data?.data ?? []}
                isLoading={fraudAlertSummary.isLoading}
                emptyState={<EmptyState title="No fraud alerts in this range" />}
              />
              <div className="mt-6 border-t pt-6">
                <FraudAlertManagementPanel />
              </div>
              </>}
            </TabsContent>

            <TabsContent value="DISCOUNT_COMPLIANCE">
              {!selectedBranchId ? (
                <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
              ) : discountCompliance.isError ? <ErrorState retry={() => discountCompliance.refetch()} /> : <>
              <ReportLastUpdated timestamp={discountCompliance.data?.generated_at} isLoading={discountCompliance.isLoading} />
              <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-3">
                <KpiCard
                  title="Discounted Transactions"
                  value={(discountCompliance.data?.data ?? []).reduce((sum, r) => sum + r.transaction_count, 0)}
                  isLoading={discountCompliance.isLoading}
                />
                <KpiCard
                  title="Total Discount Amount"
                  value={(discountCompliance.data?.data ?? []).reduce((sum, r) => sum + r.total_discount_amount, 0)}
                  isLoading={discountCompliance.isLoading}
                  tone="warning"
                />
                <KpiCard
                  title="Total VAT Exempt Amount"
                  value={(discountCompliance.data?.data ?? []).reduce((sum, r) => sum + r.total_vat_exempt_amount, 0)}
                  isLoading={discountCompliance.isLoading}
                />
              </div>
              <DataTable
                columns={discountComplianceColumns}
                data={discountCompliance.data?.data ?? []}
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
                  title="Stock In"
                  value={(inventoryMovement.data?.data ?? []).filter((r) => r.movement_type === 'stock_in').length}
                  isLoading={inventoryMovement.isLoading}
                />
                <KpiCard
                  title="Waste"
                  value={(inventoryMovement.data?.data ?? []).filter((r) => r.movement_type === 'waste').length}
                  isLoading={inventoryMovement.isLoading}
                  tone="warning"
                />
              </div>
              <DataTable
                columns={inventoryMovementColumns}
                data={inventoryMovement.data?.data ?? []}
                isLoading={inventoryMovement.isLoading}
                emptyState={<EmptyState title="No inventory movements in this range" />}
              />
              </>}
            </TabsContent>

            <TabsContent value="INVENTORY_CONSUMPTION_SUMMARY">
              {!selectedBranchId ? (
                <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
              ) : inventoryConsumptionSummary.isError ? <ErrorState retry={() => inventoryConsumptionSummary.refetch()} /> : <>
              <ReportLastUpdated timestamp={inventoryConsumptionSummary.data?.generated_at} isLoading={inventoryConsumptionSummary.isLoading} />
              <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <KpiCard title="Ingredients Consumed" value={(inventoryConsumptionSummary.data?.data ?? []).length} isLoading={inventoryConsumptionSummary.isLoading} />
                <KpiCard
                  title="Total Consumption Value"
                  value={(inventoryConsumptionSummary.data?.data ?? []).reduce((sum, r) => sum + r.consumption_value, 0)}
                  prefix="₱"
                  isLoading={inventoryConsumptionSummary.isLoading}
                />
              </div>
              <DataTable
                columns={inventoryConsumptionSummaryColumns}
                data={inventoryConsumptionSummary.data?.data ?? []}
                isLoading={inventoryConsumptionSummary.isLoading}
                emptyState={<EmptyState title="No consumption recorded" description="No sale-driven inventory consumption in this range." />}
              />
              </>}
            </TabsContent>

            <TabsContent value="INVENTORY_SUMMARY">
              {!selectedBranchId ? (
                <EmptyState title="Select a branch" description="Choose a branch above to view this report." />
              ) : inventorySummary.isError ? <ErrorState retry={() => inventorySummary.refetch()} /> : <>
              <ReportLastUpdated timestamp={inventorySummary.data?.generated_at} isLoading={inventorySummary.isLoading} />
              <div className="my-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <KpiCard title="Ingredients Tracked" value={(inventorySummary.data?.data ?? []).length} isLoading={inventorySummary.isLoading} />
                <KpiCard
                  title="Consumed Today (all ingredients)"
                  value={(inventorySummary.data?.data ?? []).reduce((sum, r) => sum + r.consumed_today, 0)}
                  isLoading={inventorySummary.isLoading}
                />
              </div>
              <DataTable
                columns={inventorySummaryColumns}
                data={inventorySummary.data?.data ?? []}
                isLoading={inventorySummary.isLoading}
                emptyState={<EmptyState title="No tracked inventory" description="No trackable inventory items at this branch." />}
              />
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
                columns={attendanceSummaryColumns}
                data={attendanceSummary.data?.data ?? []}
                isLoading={attendanceSummary.isLoading}
                emptyState={<EmptyState title="No attendance records in this range" />}
              />
              </>}
            </TabsContent>

            <TabsContent value="AUDIT_LOG">
          <LoginAuditPanel />
        </TabsContent>
      </Tabs>

      <DailySalesDrilldown
        open={drilldownRow !== null}
        onOpenChange={(o) => !o && setDrilldownRow(null)}
        branchId={drilldownRow?.branch_id ?? null}
        branchName={drilldownRow?.branch_name ?? ''}
        reportDate={drilldownRow?.report_date ?? ''}
      />

      <ReceiptModal transaction={receiptTransaction ?? null} onClose={() => setReceiptTransactionId(null)} />
      <ViewPaymentProofDialog transactionId={proofTransactionId} onOpenChange={(o) => !o && setProofTransactionId(null)} />
      <ViewTransactionItemsDialog transaction={viewItemsTransaction} onClose={() => setViewItemsTransaction(null)} />
      <ViewTransactionDetailDialog
        transaction={viewDetailTransaction}
        onClose={() => setViewDetailTransaction(null)}
        branchName={soldProductBranch.data?.name ?? null}
        cashierName={viewDetailTransaction ? (soldProductEmployeeNames.get(viewDetailTransaction.cashier_id) ?? viewDetailTransaction.cashier_id) : ''}
        attendanceRecords={[]}
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
