'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type {
  AttendanceResponse,
  ExportReadyPayload,
  ExportRequestInput,
  InventoryConsumptionSummaryReportRow,
  InventoryStockMovementResponse,
  TransactionResponse,
} from '@potato-corner/shared';
import { toast } from 'sonner';
import { DISCOUNT_PROOF_REQUIREMENT_LABELS, ROLES, reportTypeDisplayName } from '@potato-corner/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { StatusBadge } from '@/components/shared/status-badge';
import { ReportLastUpdated } from '@/components/reports/report-last-updated';
import { ExportButtons } from '@/components/reports/export-buttons';
import { ReceiptModal } from '@/components/pos/receipt-modal';
import { ViewPaymentProofDialog } from '@/components/shared/transactions/view-payment-proof-dialog';
import { ViewDiscountProofDialog } from '@/components/shared/transactions/view-discount-proof-dialog';
import { ViewTransactionItemsDialog } from '@/components/shared/transactions/view-transaction-items-dialog';
import { ViewTransactionDetailDialog } from '@/components/shared/transactions/view-transaction-detail-dialog';
import { DiscountCoverageNotice } from '@/components/reports/discount-coverage-notice';
import { ReportCoverageNotice } from '@/components/reports/report-coverage-notice';
import { DiscountProofSummary } from '@/components/reports/discount-proof-summary';
import { ALL_DISCOUNT_TYPES, DiscountTypeFilter } from '@/components/reports/discount-type-filter';
import { getDiscountBreakdownColumns } from '@/components/reports/discount-type-breakdown-columns';
import { MOVEMENT_TYPE_LABELS } from '@/lib/inventory-movement-labels';
import { discountTypeOptions, mergeDiscountRows, saleDiscountName, saleProofRequirement, summarizeDiscountProof } from '@/lib/discount-report';
import { formatCurrency, formatDateTime, formatDuration, formatInventoryQuantity, formatTimeAgo } from '@/lib/utils';
import { manilaEndOfDayISO, manilaStartOfDayISO } from '@/lib/manila-date';
import { useAuthStore } from '@/stores/auth.store';
import { useBranchStore } from '@/stores/branch.store';
import { useDiscountAuditTrail, useTransaction, useTransactions, useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { useInventoryItems, useInventoryStockMovements, useInventoryStockRealtimeSync, useUnitsOfMeasure } from '@/hooks/queries/use-universal-inventory';
import { useAttendanceByBranch, useAttendanceRealtimeSync } from '@/hooks/queries/use-attendance';
import { useEmployees } from '@/hooks/queries/use-employees';
import {
  useDiscountComplianceReport,
  useInventoryConsumptionSummaryReport,
  useReportPeriodSummary,
  useReportPeriodSummaryRealtimeSync,
  useRequestExport,
  useReportsRealtimeSync,
} from '@/hooks/queries/use-reports';

const DEFAULT_RANGE_DAYS = 7;
const QUERY_LIMIT = 100;
const REPORT_PAGE_SIZE = 25;
const DISCOUNT_DETAIL_PAGE_SIZE = 25;
const REFRESH_COOLDOWN_SECONDS = 60;
const SEARCH_DEBOUNCE_MS = 300;
const FIRST_PAGE: PaginationState = { pageIndex: 0, pageSize: REPORT_PAGE_SIZE };

const TAB_TO_REPORT_TYPE: Record<string, ExportRequestInput['report_type']> = {
  'daily-sales': 'DAILY_SALES',
  // No dedicated backend report type exists for the per-product breakdown
  // (adding one means a Prisma-enum migration for ReportType, same class of
  // change as AUDIT_LOG's 20260722021611 migration — not done without
  // approval). DAILY_SALES is the closest existing transaction-based export
  // and covers the same underlying rows.
  'sold-product-transactions': 'DAILY_SALES',
  'void-refund': 'VOID_REFUND',
  'discount-compliance': 'DISCOUNT_COMPLIANCE',
  'inventory-movement': 'INVENTORY_MOVEMENT',
  'consumption-summary': 'INVENTORY_CONSUMPTION_SUMMARY',
  'attendance-summary': 'ATTENDANCE_SUMMARY',
};

const consumptionSummaryColumns: ColumnDef<InventoryConsumptionSummaryReportRow>[] = [
  { accessorKey: 'ingredient_name', header: 'Ingredient' },
  {
    id: 'quantity_consumed',
    header: 'Stock Used',
    cell: ({ row }) => formatInventoryQuantity(row.original.quantity_consumed, row.original.unit),
  },
  { accessorKey: 'movement_count', header: 'Sales Movements' },
];

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

function humanizeSnake(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

interface VoidRefundRow {
  transaction: TransactionResponse;
  type: 'void' | 'refund';
}

/**
 * Receipt/payment-proof viewing (Phase 10-11) is Supervisor/Super Admin
 * oversight tooling, not a branch/staff feature — staff already have their
 * own Receipts page. `withActions` gates the two extra columns so the
 * branch role's Reports tab renders exactly as before.
 */
function getDailySalesColumns(
  withActions: boolean,
  onViewReceipt: (transactionId: string) => void,
  onViewProof: (transactionId: string) => void,
  employeeNames: Map<string, string>,
  discountCustomerIdByTransaction: Map<string, string | null>,
): ColumnDef<TransactionResponse>[] {
  const columns: ColumnDef<TransactionResponse>[] = [
    { id: 'receipt_number', header: 'Receipt #', accessorKey: 'receipt_number' },
    {
      id: 'payment_method',
      header: 'Payment',
      cell: ({ row }) => <Badge variant="outline">{humanizeSnake(row.original.payment_method)}</Badge>,
    },
    { id: 'total_amount', header: 'Total', cell: ({ row }) => formatCurrency(row.original.total_amount) },
    { id: 'discount_amount', header: 'Discount', cell: ({ row }) => formatCurrency(row.original.discount_amount) },
    {
      id: 'discount_type',
      header: 'Discount Type',
      cell: ({ row }) => saleDiscountName(row.original) ?? '—',
    },
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
  ];
  if (!withActions) return columns;
  return [
    ...columns,
    {
      // Same PII-visibility boundary as Cashier/Proof Available below
      // (withActions === supervisor only) — sourced from the discount-audit
      // trail endpoint already fetched for the Discount Report tab, not
      // a new query.
      id: 'customer_id',
      header: 'Customer ID / Reference',
      cell: ({ row }) => discountCustomerIdByTransaction.get(row.original.id) ?? '—',
    },
    {
      id: 'cashier',
      header: 'Cashier',
      cell: ({ row }) => row.original.cashier_name ?? employeeNames.get(row.original.cashier_id) ?? row.original.cashier_id,
    },
    {
      id: 'payment_proof',
      header: 'Payment Proof',
      cell: ({ row }) => {
        const txn = row.original;
        if (txn.payment_method === 'cash') return <span className="text-xs text-muted-foreground">—</span>;
        if (!txn.has_payment_proof) return <span className="text-xs text-muted-foreground">No proof uploaded</span>;
        return (
          <Button type="button" variant="ghost" size="sm" onClick={() => onViewProof(txn.id)}>
            View Proof
          </Button>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <Button type="button" variant="outline" size="sm" onClick={() => onViewReceipt(row.original.id)}>
          View Receipt
        </Button>
      ),
    },
  ];
}

/**
 * Sold Product Transactions (Reports §10) — one row per transaction (never
 * per product line, so Subtotal/Discount/Total are never duplicated);
 * the Items cell opens ViewTransactionItemsDialog for the product/variant/
 * quantity/unit-price breakdown, per the report's "expandable row OR a View
 * Items action" allowance.
 */
function getSoldProductTransactionsColumns(
  withActions: boolean,
  employeeNames: Map<string, string>,
  onViewItems: (transaction: TransactionResponse) => void,
  onViewTransaction: (transaction: TransactionResponse) => void,
  onViewReceipt: (transactionId: string) => void,
  onViewProof: (transactionId: string) => void,
): ColumnDef<TransactionResponse>[] {
  const columns: ColumnDef<TransactionResponse>[] = [
    { id: 'created_at', header: 'Date and Time', cell: ({ row }) => formatDateTime(row.original.created_at) },
    { id: 'receipt_number', header: 'Receipt #', accessorKey: 'receipt_number' },
    {
      id: 'cashier',
      header: 'Cashier',
      cell: ({ row }) => row.original.cashier_name ?? employeeNames.get(row.original.cashier_id) ?? row.original.cashier_id,
    },
    {
      id: 'items',
      header: 'Items',
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
    { id: 'discount_amount', header: 'Discount', cell: ({ row }) => formatCurrency(row.original.discount_amount) },
    { id: 'total_amount', header: 'Total', cell: ({ row }) => formatCurrency(row.original.total_amount) },
    {
      id: 'payment_method',
      header: 'Payment Method',
      cell: ({ row }) => <Badge variant="outline">{humanizeSnake(row.original.payment_method)}</Badge>,
    },
    { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} type="transaction" /> },
  ];
  if (!withActions) return columns;
  return [
    ...columns,
    {
      id: 'payment_proof',
      header: 'Payment Proof',
      cell: ({ row }) => {
        const txn = row.original;
        if (txn.payment_method === 'cash') return <span className="text-xs text-muted-foreground">—</span>;
        if (!txn.has_payment_proof) return <span className="text-xs text-muted-foreground">No payment proof uploaded</span>;
        return (
          <Button type="button" variant="ghost" size="sm" onClick={() => onViewProof(txn.id)}>
            View Proof
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

/**
 * Task 209.5 — Proof Available/View Proof columns only render for
 * `withActions` (Supervisor), same authorization gate getDailySalesColumns'
 * payment_proof column already uses: branch role sees the compliance rows
 * without any proof indicator, matching this report's existing permission
 * model for proof-photo access.
 */
function getDiscountComplianceColumns(
  withActions: boolean,
  onViewProof: (transactionId: string) => void,
  employeeNames: Map<string, string>,
  discountCustomerIdByTransaction: Map<string, string | null>,
): ColumnDef<TransactionResponse>[] {
  const columns: ColumnDef<TransactionResponse>[] = [
    { id: 'receipt_number', header: 'Receipt #', accessorKey: 'receipt_number' },
    {
      id: 'discount_type',
      header: 'Discount Type',
      cell: ({ row }) => {
        const name = saleDiscountName(row.original);
        return name ? <Badge variant="secondary">{name}</Badge> : '—';
      },
    },
    { id: 'discount_amount', header: 'Discount', cell: ({ row }) => formatCurrency(row.original.discount_amount) },
    { id: 'total_amount', header: 'Total', cell: ({ row }) => formatCurrency(row.original.total_amount) },
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
  ];
  if (!withActions) return columns;
  return [
    ...columns,
    {
      id: 'cashier',
      header: 'Cashier',
      cell: ({ row }) => row.original.cashier_name ?? employeeNames.get(row.original.cashier_id) ?? row.original.cashier_id,
    },
    {
      // Same PII-visibility boundary as Cashier/Proof Available above
      // (withActions === supervisor/super_admin only, never branch/staff) —
      // sourced from the discount-audit trail endpoint, not a new query.
      id: 'customer_id',
      header: 'Customer ID / Reference',
      cell: ({ row }) => discountCustomerIdByTransaction.get(row.original.id) ?? '—',
    },
    {
      id: 'proof_requirement',
      header: 'Proof Requirement',
      cell: ({ row }) => DISCOUNT_PROOF_REQUIREMENT_LABELS[saleProofRequirement(row.original)],
    },
    {
      id: 'discount_proof',
      header: 'Proof Available',
      cell: ({ row }) => {
        const txn = row.original;
        if (!txn.has_discount_proof) return <span className="text-xs text-muted-foreground">No</span>;
        return (
          <Button type="button" variant="ghost" size="sm" onClick={() => onViewProof(txn.id)}>
            Yes · View Proof
          </Button>
        );
      },
    },
  ];
}

function createInventoryStockMovementColumns(
  unitCodes: Map<string, string>,
  itemSkus: Map<string, string | null>,
  performedByNames: Map<string, string>,
): ColumnDef<InventoryStockMovementResponse>[] {
  return [
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
    { id: 'inventory_item_name', header: 'Item', accessorKey: 'inventory_item_name' },
    { id: 'sku', header: 'SKU', cell: ({ row }) => itemSkus.get(row.original.inventory_item_id) ?? '—' },
    {
      id: 'movement_type',
      header: 'Type',
      cell: ({ row }) => <Badge variant="outline">{MOVEMENT_TYPE_LABELS[row.original.movement_type]}</Badge>,
    },
    { id: 'quantity_before', header: 'Before', cell: ({ row }) => row.original.quantity_before },
    {
      id: 'quantity_change',
      header: 'Change',
      cell: ({ row }) => (
        <span className={row.original.quantity_change < 0 ? 'text-destructive' : 'text-success'}>
          {row.original.quantity_change > 0 ? '+' : ''}
          {row.original.quantity_change}
        </span>
      ),
    },
    { id: 'quantity_after', header: 'After', cell: ({ row }) => row.original.quantity_after },
    {
      id: 'unit',
      header: 'Unit',
      cell: ({ row }) => (row.original.unit_id ? (unitCodes.get(row.original.unit_id) ?? '—') : '—'),
    },
    { id: 'reference_type', header: 'Reference Type', cell: ({ row }) => row.original.reference_type ?? '—' },
    { id: 'reference_id', header: 'Reference ID', cell: ({ row }) => row.original.reference_id ?? '—' },
    { id: 'notes', header: 'Notes', cell: ({ row }) => row.original.notes ?? '—' },
    {
      id: 'performed_by',
      header: 'Performed By',
      cell: ({ row }) =>
        row.original.performed_by_user_id
          ? (performedByNames.get(row.original.performed_by_user_id) ?? row.original.performed_by_user_id)
          : '—',
    },
    {
      id: 'responsible',
      header: 'Responsible Staff',
      cell: ({ row }) => row.original.responsible_user_name ?? '—',
    },
    {
      id: 'proof',
      header: 'Proof',
      cell: ({ row }) =>
        row.original.proof_url ? (
          <a href={row.original.proof_url} target="_blank" rel="noreferrer" className="text-primary underline">
            View Proof
          </a>
        ) : (
          '—'
        ),
    },
  ];
}

function createAttendanceSummaryColumns(employeeNames: Map<string, string>): ColumnDef<AttendanceResponse>[] {
  return [
    { id: 'employee', header: 'Employee', cell: ({ row }) => employeeNames.get(row.original.employee_id) ?? row.original.employee_id },
    { id: 'clock_in_server_time', header: 'Time In', cell: ({ row }) => formatDateTime(row.original.clock_in_server_time) },
    {
      id: 'clock_out_server_time',
      header: 'Time Out',
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
 * Shared body behind both `/supervisor/reports` and `/branch/reports` — a
 * real-time-only report tier (Phase 20 scope lock): every report below is
 * composed client-side from existing list queries. Branch is implicit from
 * useBranchStore (a supervisor's BranchSelector, or the branch role's
 * JWT-seeded value — see BranchContextSync), matching every other
 * branch-scoped data page.
 *
 * Export, manual refresh with a cooldown, and export-ready realtime
 * notifications are layered on top via the /api/reports/export endpoint —
 * the 7 tabs' underlying data still come from this lightweight
 * client-composed tier, unchanged.
 *
 * Queries are fired in parallel (no sequential/waterfall awaits) so a tab's
 * data is ready by the time the user switches to it. POS-PERF-P59 — every
 * table pages through the server, and every card reads a server aggregate of
 * all matching records, so nothing here depends on the rows on one page.
 *
 * The date range lives at the page level (not per-tab) so switching tabs
 * never resets it.
 */
export function ReportsView() {
  useTransactionsRealtimeSync();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const activeBranch = useBranchStore((s) => s.activeBranch);
  useInventoryStockRealtimeSync(activeBranchId);
  useAttendanceRealtimeSync();

  const currentUserId = useAuthStore((s) => s.user?.id);
  const isSupervisor = useAuthStore((s) => s.user?.role === ROLES.SUPERVISOR);
  // Task 209.16 — the Discount Report's Proof Available/View Proof column
  // and KPIs were supervisor-only; the owner explicitly requires Admin
  // (super_admin) to see discount ID proof here too. Scoped to just this
  // tab's `withActions` gate (see getDiscountComplianceColumns below), not
  // every other `isSupervisor` check in this component — those gate
  // unrelated actions this task doesn't touch.
  const isSuperAdmin = useAuthStore((s) => s.user?.role === ROLES.SUPER_ADMIN);
  const canViewDiscountProof = isSupervisor || isSuperAdmin;
  // POS-PERF-P59 — the report API refuses the staff role, so staff get the sales list they may read, never a false ₱0 summary.
  const canReadReportSummaries = useAuthStore((s) => s.user?.role !== ROLES.STAFF);
  const requestExport = useRequestExport();
  const [activeTab, setActiveTab] = useState('daily-sales');
  const [refreshDisabled, setRefreshDisabled] = useState(false);
  const [refreshCooldown, setRefreshCooldown] = useState(0);
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [receiptTransactionId, setReceiptTransactionId] = useState<string | null>(null);
  const [proofTransactionId, setProofTransactionId] = useState<string | null>(null);
  const [discountProofTransactionId, setDiscountProofTransactionId] = useState<string | null>(null);
  const [viewItemsTransaction, setViewItemsTransaction] = useState<TransactionResponse | null>(null);
  const [viewDetailTransaction, setViewDetailTransaction] = useState<TransactionResponse | null>(null);
  const [discountTypeFilter, setDiscountTypeFilter] = useState(ALL_DISCOUNT_TYPES);
  const [discountPagination, setDiscountPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: DISCOUNT_DETAIL_PAGE_SIZE });
  const [dailyPagination, setDailyPagination] = useState<PaginationState>(FIRST_PAGE);
  const [voidRefundPagination, setVoidRefundPagination] = useState<PaginationState>(FIRST_PAGE);
  const [movementPagination, setMovementPagination] = useState<PaginationState>(FIRST_PAGE);
  const [consumptionPagination, setConsumptionPagination] = useState<PaginationState>(FIRST_PAGE);
  const [attendancePagination, setAttendancePagination] = useState<PaginationState>(FIRST_PAGE);
  const { data: receiptTransaction } = useTransaction(receiptTransactionId);

  // Sold Product Transactions filters — sent to the server, so they cover every sale in the period.
  const [soldReceiptSearch, setSoldReceiptSearch] = useState('');
  const [soldReceiptQuery, setSoldReceiptQuery] = useState('');
  const [soldCashierFilter, setSoldCashierFilter] = useState('all');
  const [soldPaymentMethodFilter, setSoldPaymentMethodFilter] = useState('all');
  const [soldStatusFilter, setSoldStatusFilter] = useState('all');
  const [soldProductFilter, setSoldProductFilter] = useState('all');
  const [soldPagination, setSoldPagination] = useState<PaginationState>(FIRST_PAGE);

  useEffect(() => {
    const timer = setTimeout(() => setSoldReceiptQuery(soldReceiptSearch.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [soldReceiptSearch]);

  function resetReportPages() {
    for (const setPagination of [setDiscountPagination, setDailyPagination, setVoidRefundPagination, setMovementPagination, setConsumptionPagination, setAttendancePagination, setSoldPagination]) {
      setPagination((p) => ({ ...p, pageIndex: 0 }));
    }
  }

  useEffect(resetReportPages, [activeBranchId]);

  useReportPeriodSummaryRealtimeSync();
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

  const [fromInput, setFromInput] = useState(() => daysAgoDateString(DEFAULT_RANGE_DAYS));
  const [toInput, setToInput] = useState(() => todayDateString());
  const [dateRange, setDateRange] = useState(() => ({ from: daysAgoDateString(DEFAULT_RANGE_DAYS), to: todayDateString() }));

  // Screen data with an instant filter and its export must cover the same
  // window: the export sends a bare date to /api/reports/export, which the
  // backend resolves to a Manila calendar-day boundary (manila-time.ts).
  // These endpoints require a precise ISO instant, so it's computed the same
  // way client-side instead of browser-local midnight, which drifts from
  // Manila whenever the browser isn't on that timezone.
  const manilaRangeStartISO = manilaStartOfDayISO(dateRange.from);
  const manilaRangeEndISO = manilaEndOfDayISO(dateRange.to);

  const completedQuery = useTransactions({
    branch_id: activeBranchId ?? undefined,
    status: 'completed',
    date_from: dateRange.from,
    date_to: dateRange.to,
    page: dailyPagination.pageIndex + 1,
    limit: dailyPagination.pageSize,
  });
  // Every card on these tabs, across every matching record: never the rows on one page.
  const periodSummaryQuery = useReportPeriodSummary(
    { branch_id: activeBranchId ?? undefined, date_from: dateRange.from, date_to: dateRange.to },
    canReadReportSummaries,
  );
  // Task 209.56E — the Discount Report tab's headline KPIs (total discount
  // amount, discounted-transaction count) used
  // to be reduced client-side from completedQuery's rows, which are capped
  // at QUERY_LIMIT (100). Any branch/date-range with more than 100 completed
  // transactions silently undercounted every one of those numbers — the
  // same reused reducer must've felt consistent internally but is a real
  // financial-reporting gap. getDiscountCompliance is a SQL groupBy over
  // the full date range (already what Admin Reports uses for the same
  // numbers), so switching these KPIs to it removes the cap without a
  // second discount formula: it's the same discountAmount/discountType
  // columns, aggregated server-side instead of paginated-then-reduced.
  // POS-PERF-P59 — the proof summary reads it too, and the detail table has its
  // own server-paginated query below, so neither stops at the newest 100 sales.
  const discountComplianceQuery = useDiscountComplianceReport({
    branch_id: activeBranchId ?? undefined,
    date_from: dateRange.from,
    date_to: dateRange.to,
    limit: QUERY_LIMIT,
  }, canReadReportSummaries);
  // Task: Discount Report parity — reuses the same discount-audit trail
  // endpoint the Admin drilldown already calls (GET /transactions/discount-audit)
  // purely to source discountCustomerId per transaction id, not as this tab's
  // row source. POS-PERF-P59 — asks for exactly the Daily Sales page's discounted
  // sales, so a row on any page finds its value. Gated to canViewDiscountProof so
  // branch/staff sessions never issue this supervisor/admin-only request.
  const dailyDiscountedIds = (completedQuery.data?.transactions ?? []).filter((t) => t.discount_type !== null).map((t) => t.id);
  const discountAuditQuery = useDiscountAuditTrail(
    { branchId: activeBranchId ?? undefined, transactionIds: dailyDiscountedIds, page: 1, limit: QUERY_LIMIT },
    canViewDiscountProof && dailyDiscountedIds.length > 0,
  );
  // POS-PERF-P59 — the Discount Report's own rows: same filter as its KPIs and
  // export, one page at a time, every discounted sale reachable.
  const activeDiscountKey = discountTypeFilter === ALL_DISCOUNT_TYPES ? undefined : discountTypeFilter;
  const discountDetailQuery = useTransactions({
    branch_id: activeBranchId ?? undefined,
    status: 'completed',
    discounted_only: 'true',
    discount_key: activeDiscountKey,
    date_from: dateRange.from,
    date_to: dateRange.to,
    page: discountPagination.pageIndex + 1,
    limit: discountPagination.pageSize,
  });
  const discountDetailAuditQuery = useDiscountAuditTrail(
    {
      branchId: activeBranchId ?? undefined,
      discountKey: activeDiscountKey,
      dateFrom: dateRange.from,
      dateTo: dateRange.to,
      page: discountPagination.pageIndex + 1,
      limit: discountPagination.pageSize,
    },
    canViewDiscountProof && activeTab === 'discount-compliance',
  );
  const discountRows = useMemo(() => mergeDiscountRows(discountComplianceQuery.data?.data ?? []), [discountComplianceQuery.data]);
  // A chosen type can drop out when the branch or dates change: back to all types rather than an empty report.
  useEffect(() => {
    if (activeDiscountKey && discountComplianceQuery.data && !discountRows.some((r) => r.discount_key === activeDiscountKey)) setDiscountTypeFilter(ALL_DISCOUNT_TYPES);
  }, [activeDiscountKey, discountComplianceQuery.data, discountRows]);
  // Sold Product Transactions — deliberately not status-filtered by default
  // (unlike completedQuery above) so voided/refunded rows can show too.
  const soldTransactionsQuery = useTransactions({
    branch_id: activeBranchId ?? undefined,
    date_from: dateRange.from,
    date_to: dateRange.to,
    receipt_search: soldReceiptQuery || undefined,
    cashier_id: soldCashierFilter !== 'all' ? soldCashierFilter : undefined,
    payment_method: soldPaymentMethodFilter !== 'all' ? (soldPaymentMethodFilter as TransactionResponse['payment_method']) : undefined,
    status: soldStatusFilter !== 'all' ? (soldStatusFilter as TransactionResponse['status']) : undefined,
    product_name: soldProductFilter !== 'all' ? soldProductFilter : undefined,
    page: soldPagination.pageIndex + 1,
    limit: soldPagination.pageSize,
  });
  const voidRefundQuery = useTransactions({
    branch_id: activeBranchId ?? undefined,
    status_group: 'void_refund',
    date_from: dateRange.from,
    date_to: dateRange.to,
    page: voidRefundPagination.pageIndex + 1,
    limit: voidRefundPagination.pageSize,
  });
  const movementsQuery = useInventoryStockMovements(activeBranchId, {
    from_date: manilaRangeStartISO,
    to_date: manilaRangeEndISO,
    page: movementPagination.pageIndex + 1,
    limit: movementPagination.pageSize,
  });
  // The same server aggregate as this tab's export. Only read while the tab is
  // open: the aggregate loads the period's sale movements on the server.
  const consumptionQuery = useInventoryConsumptionSummaryReport(
    {
      branch_id: activeBranchId ?? undefined,
      date_from: dateRange.from,
      date_to: dateRange.to,
      page: consumptionPagination.pageIndex + 1,
      limit: consumptionPagination.pageSize,
    },
    canReadReportSummaries && activeTab === 'consumption-summary',
  );
  const attendanceQuery = useAttendanceByBranch(activeBranchId, {
    from: manilaRangeStartISO,
    to: manilaRangeEndISO,
    page: attendancePagination.pageIndex + 1,
    limit: attendancePagination.pageSize,
  });
  // For the open transaction's cashier only, so a sale on any page can find the
  // clock-in session covering it, whatever page the Attendance tab is on.
  const saleSessionQuery = useAttendanceByBranch(
    activeBranchId,
    {
      employee_id: viewDetailTransaction?.cashier_id,
      from: viewDetailTransaction ? new Date(new Date(viewDetailTransaction.created_at).getTime() - 24 * 60 * 60 * 1000).toISOString() : undefined,
      to: viewDetailTransaction?.created_at,
      page: 1,
      limit: QUERY_LIMIT,
    },
    { enabled: viewDetailTransaction !== null },
  );
  const employeesQuery = useEmployees({ branchId: activeBranchId ?? undefined, limit: QUERY_LIMIT });
  const unitsQuery = useUnitsOfMeasure();
  const inventoryItemsQuery = useInventoryItems();

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its reports.</p>;
  }

  function handleRefresh() {
    setDateRange({ from: fromInput, to: toInput });
    resetReportPages();
    setRefreshDisabled(true);
    setRefreshCooldown(REFRESH_COOLDOWN_SECONDS);
  }

  function handleExport(format: 'csv' | 'pdf') {
    const setIsExporting = format === 'csv' ? setIsExportingCsv : setIsExportingPdf;
    setIsExporting(true);
    // Sold Product Transactions shares DAILY_SALES's report_type (no
    // dedicated backend ReportType — see TAB_TO_REPORT_TYPE's comment
    // above) but has its own filter bar; forwarding those filters and its
    // view here is what keeps the CSV/PDF population matching what's on
    // screen for this tab specifically. Every other tab keeps sending just
    // branch/date, same as before.
    const soldTabFilters =
      activeTab === 'sold-product-transactions'
        ? {
            report_view: 'sold_product_transactions' as const,
            product_name: soldProductFilter !== 'all' ? soldProductFilter : undefined,
            cashier_id: soldCashierFilter !== 'all' ? soldCashierFilter : undefined,
            payment_method: soldPaymentMethodFilter !== 'all' ? (soldPaymentMethodFilter as ExportRequestInput['filters']['payment_method']) : undefined,
            status: soldStatusFilter !== 'all' ? (soldStatusFilter as ExportRequestInput['filters']['status']) : undefined,
            search: soldReceiptSearch.trim() || undefined,
          }
        : {};
    const input: ExportRequestInput = {
      report_type: TAB_TO_REPORT_TYPE[activeTab] ?? 'DAILY_SALES',
      filters: {
        branch_id: activeBranchId ?? undefined,
        date_from: dateRange.from,
        date_to: dateRange.to,
        page: 1,
        limit: QUERY_LIMIT,
        ...soldTabFilters,
        ...(activeTab === 'discount-compliance' && activeDiscountKey ? { discount_key: activeDiscountKey } : {}),
      },
      format,
    };
    requestExport.mutate(input, { onSettled: () => setIsExporting(false) });
  }

  // POS-PERF-P59 — every card below reads this aggregate of all matching
  // records. When it isn't available a card says so, never a false 0.
  const periodSummary = periodSummaryQuery.data;
  const summaryUnavailable = !canReadReportSummaries || periodSummaryQuery.isError;
  const summaryValueText = summaryUnavailable ? 'Unavailable' : undefined;
  const summaryLoading = canReadReportSummaries && periodSummaryQuery.isLoading;

  // Daily Sales
  const completedTransactions = completedQuery.data?.transactions ?? [];

  // Sold Product Transactions. Product names come from the aggregate, as one page
  // can't list them all; staff can't read it, so they choose from the current page.
  const soldTransactions = soldTransactionsQuery.data?.transactions ?? [];
  const soldProductOptions = periodSummary?.sold_product_names ?? Array.from(new Set(soldTransactions.flatMap((t) => (t.items ?? []).map((i) => i.product_name)))).sort();

  // Void/Refund
  const voidRefundRows: VoidRefundRow[] = (voidRefundQuery.data?.transactions ?? []).map((transaction) => ({
    transaction,
    type: transaction.status === 'voided' ? 'void' : 'refund',
  }));

  // Discount Report — every figure comes from the server-side aggregate (see
  // discountComplianceQuery above), filtered here by discount identity. The
  // choices come from the unfiltered rows, so a filter can always be changed.
  const discountOptions = discountTypeOptions(discountRows);
  const visibleDiscountRows = activeDiscountKey ? discountRows.filter((r) => r.discount_key === activeDiscountKey) : discountRows;
  const discountedTransactions = (discountDetailQuery.data?.transactions ?? []).filter((t) => t.discount_type !== null);
  const discountCustomerIdByTransaction = new Map(
    (discountAuditQuery.data?.data ?? []).map((row) => [row.id, row.discountCustomerId]),
  );
  const discountDetailCustomerIds = new Map(
    (discountDetailAuditQuery.data?.data ?? []).map((row) => [row.id, row.discountCustomerId]),
  );
  const totalDiscountedTransactions = visibleDiscountRows.reduce((sum, r) => sum + r.transaction_count, 0);
  const totalDiscountAmount = visibleDiscountRows.reduce((sum, r) => sum + r.total_discount_amount, 0);
  const proofSummary = summarizeDiscountProof(visibleDiscountRows);

  // Inventory Movement
  const movements = movementsQuery.data?.movements ?? [];
  const unitCodes = new Map((unitsQuery.data ?? []).map((u) => [u.id, u.code]));
  const itemSkus = new Map((inventoryItemsQuery.data ?? []).map((i) => [i.id, i.sku]));

  // Stock Used Summary. TASK 209.9: no overall quantity total — these rows mix
  // grams, kg, and pc across ingredients, so summing quantity_consumed across
  // rows is mathematically meaningless (can't add grams and pieces).
  const consumptionRows = consumptionQuery.data?.data ?? [];

  // Attendance Summary
  const attendanceRecords = attendanceQuery.data?.records ?? [];
  const employeeNames = new Map((employeesQuery.data?.employees ?? []).map((e) => [e.id, `${e.first_name} ${e.last_name}`]));
  const attendanceSummaryColumns = createAttendanceSummaryColumns(employeeNames);
  const inventoryMovementColumns = createInventoryStockMovementColumns(unitCodes, itemSkus, employeeNames);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Branch Reports</h1>
        <p className="text-sm text-muted-foreground">Real-time reports composed from live data for your active branch.</p>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="grid grid-cols-2 gap-3 sm:flex sm:w-auto sm:gap-4">
          <div className="w-full sm:w-auto">
            <Label htmlFor="reports-from">From</Label>
            <Input id="reports-from" type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} className="w-full" />
          </div>
          <div className="w-full sm:w-auto">
            <Label htmlFor="reports-to">To</Label>
            <Input id="reports-to" type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} className="w-full" />
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button onClick={handleRefresh} disabled={refreshDisabled} className="w-full sm:w-auto">
            {refreshDisabled ? `Refresh (${refreshCooldown}s)` : 'Refresh'}
          </Button>
          <ExportButtons
            onExportCsv={() => handleExport('csv')}
            onExportPdf={() => handleExport('pdf')}
            isExportingCsv={isExportingCsv}
            isExportingPdf={isExportingPdf}
          />
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="daily-sales">Daily Sales Report (DSR)</TabsTrigger>
          <TabsTrigger value="sold-product-transactions">Sold Product Transactions</TabsTrigger>
          <TabsTrigger value="void-refund">Void/Refund</TabsTrigger>
          <TabsTrigger value="discount-compliance">Discount Report</TabsTrigger>
          <TabsTrigger value="inventory-movement">Inventory Movement</TabsTrigger>
          <TabsTrigger value="consumption-summary">Stock Used Summary</TabsTrigger>
          <TabsTrigger value="attendance-summary">Attendance Summary</TabsTrigger>
        </TabsList>

        <TabsContent value="daily-sales" className="space-y-4">
          <ReportLastUpdated
            timestamp={completedQuery.dataUpdatedAt ? new Date(completedQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={completedQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard title="Total Transactions" value={periodSummary?.sales.completed_count ?? 0} valueText={summaryValueText} isLoading={summaryLoading} />
            <KpiCard
              title="Total Sales — Selected Period"
              value={periodSummary?.sales.completed_total_amount ?? 0}
              prefix="₱"
              valueText={summaryValueText}
              isLoading={summaryLoading}
              tooltip={`Completed transaction totals, after discounts, from ${dateRange.from} to ${dateRange.to}. For pre-discount Gross Sales, see Admin Reports > Financial Summary.`}
            />
            <KpiCard title="Discounts Given" value={periodSummary?.sales.completed_discount_amount ?? 0} prefix="₱" valueText={summaryValueText} isLoading={summaryLoading} />
          </div>
          <ReportCoverageNotice count={completedQuery.data?.total} noun="completed sales" hasTotals={!summaryUnavailable} />
          <DataTable
            stickyHeader
            columns={getDailySalesColumns(isSupervisor, setReceiptTransactionId, setProofTransactionId, employeeNames, discountCustomerIdByTransaction)}
            data={completedTransactions}
            isLoading={completedQuery.isLoading}
            isError={completedQuery.isError}
            onRetry={() => void completedQuery.refetch()}
            pagination={dailyPagination}
            onPaginationChange={setDailyPagination}
            rowCount={completedQuery.data?.total ?? completedTransactions.length}
            emptyState={<EmptyState title="No sales" description="No completed transactions in this date range." />}
          />
        </TabsContent>

        <TabsContent value="sold-product-transactions" className="space-y-4">
          <ReportLastUpdated
            timestamp={soldTransactionsQuery.dataUpdatedAt ? new Date(soldTransactionsQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={soldTransactionsQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end lg:flex lg:flex-wrap">
            <div className="w-full lg:w-auto">
              <Label htmlFor="sold-receipt-search">Receipt #</Label>
              <Input
                id="sold-receipt-search"
                placeholder="Search receipt number"
                className="w-full lg:w-[180px]"
                value={soldReceiptSearch}
                onChange={(e) => {
                  setSoldReceiptSearch(e.target.value);
                  setSoldPagination((p) => ({ ...p, pageIndex: 0 }));
                }}
              />
            </div>
            <div className="w-full lg:w-auto">
              <Label>Cashier</Label>
              <Select
                value={soldCashierFilter}
                onValueChange={(v) => {
                  setSoldCashierFilter(v);
                  setSoldPagination((p) => ({ ...p, pageIndex: 0 }));
                }}
              >
                <SelectTrigger className="w-full lg:w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All cashiers</SelectItem>
                  {Array.from(employeeNames.entries()).map(([id, name]) => (
                    <SelectItem key={id} value={id}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-full lg:w-auto">
              <Label>Payment Method</Label>
              <Select
                value={soldPaymentMethodFilter}
                onValueChange={(v) => {
                  setSoldPaymentMethodFilter(v);
                  setSoldPagination((p) => ({ ...p, pageIndex: 0 }));
                }}
              >
                <SelectTrigger className="w-full lg:w-[150px]">
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
            <div className="w-full lg:w-auto">
              <Label>Status</Label>
              <Select
                value={soldStatusFilter}
                onValueChange={(v) => {
                  setSoldStatusFilter(v);
                  setSoldPagination((p) => ({ ...p, pageIndex: 0 }));
                }}
              >
                <SelectTrigger className="w-full lg:w-[150px]">
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
            <div className="w-full lg:w-auto">
              <Label>Product</Label>
              <Select
                value={soldProductFilter}
                onValueChange={(v) => {
                  setSoldProductFilter(v);
                  setSoldPagination((p) => ({ ...p, pageIndex: 0 }));
                }}
              >
                <SelectTrigger className="w-full lg:w-[170px]">
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
          <ReportCoverageNotice count={soldTransactionsQuery.data?.total} noun="sold product transactions" hasTotals={false} />
          <DataTable
            stickyHeader
            columns={getSoldProductTransactionsColumns(
              isSupervisor,
              employeeNames,
              setViewItemsTransaction,
              setViewDetailTransaction,
              setReceiptTransactionId,
              setProofTransactionId,
            )}
            data={soldTransactions}
            isLoading={soldTransactionsQuery.isLoading}
            isError={soldTransactionsQuery.isError}
            onRetry={() => void soldTransactionsQuery.refetch()}
            pagination={soldPagination}
            onPaginationChange={setSoldPagination}
            rowCount={soldTransactionsQuery.data?.total ?? soldTransactions.length}
            emptyState={<EmptyState title="No sold products" description="No product sales match these filters in this date range." />}
          />
        </TabsContent>

        <TabsContent value="void-refund" className="space-y-4">
          <ReportLastUpdated
            timestamp={voidRefundQuery.dataUpdatedAt ? new Date(voidRefundQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={voidRefundQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Total Voided" value={periodSummary?.sales.voided_count ?? 0} valueText={summaryValueText} isLoading={summaryLoading} />
            <KpiCard title="Total Refunded" value={periodSummary?.sales.refunded_count ?? 0} valueText={summaryValueText} isLoading={summaryLoading} />
            <KpiCard title="Voided Amount" value={periodSummary?.sales.voided_total_amount ?? 0} prefix="₱" valueText={summaryValueText} isLoading={summaryLoading} />
            <KpiCard title="Refunded Amount" value={periodSummary?.sales.refunded_total_amount ?? 0} prefix="₱" valueText={summaryValueText} isLoading={summaryLoading} />
          </div>
          <ReportCoverageNotice count={voidRefundQuery.data?.total} noun="voided or refunded sales" hasTotals={!summaryUnavailable} />
          <DataTable
            stickyHeader
            columns={voidRefundColumns}
            data={voidRefundRows}
            isLoading={voidRefundQuery.isLoading}
            isError={voidRefundQuery.isError}
            onRetry={() => void voidRefundQuery.refetch()}
            pagination={voidRefundPagination}
            onPaginationChange={setVoidRefundPagination}
            rowCount={voidRefundQuery.data?.total ?? voidRefundRows.length}
            emptyState={<EmptyState title="No voids or refunds" description="No voided or refunded transactions in this date range." />}
          />
        </TabsContent>

        <TabsContent value="discount-compliance" className="space-y-4">
          {canReadReportSummaries && (
            <>
              <ReportLastUpdated
                timestamp={discountComplianceQuery.dataUpdatedAt ? new Date(discountComplianceQuery.dataUpdatedAt).toISOString() : undefined}
                isLoading={discountComplianceQuery.isLoading}
              />
              <DiscountTypeFilter
                options={discountOptions}
                value={discountTypeFilter}
                onChange={(value) => {
                  setDiscountTypeFilter(value);
                  setDiscountPagination((p) => ({ ...p, pageIndex: 0 }));
                }}
              />
              {discountComplianceQuery.data && (
                <DiscountCoverageNotice
                  rowsReturned={discountComplianceQuery.data.data.length}
                  rowsTotal={discountComplianceQuery.data.total}
                  transactionCount={totalDiscountedTransactions}
                  showExportLimits
                />
              )}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <KpiCard title="Total Discounted Transactions" value={totalDiscountedTransactions} valueText={discountComplianceQuery.isError ? 'Unavailable' : undefined} isLoading={discountComplianceQuery.isLoading} />
                <KpiCard title="Total Discount Amount" value={totalDiscountAmount} prefix="₱" valueText={discountComplianceQuery.isError ? 'Unavailable' : undefined} isLoading={discountComplianceQuery.isLoading} />
              </div>
              {canViewDiscountProof && !discountComplianceQuery.isError && <DiscountProofSummary summary={proofSummary} isLoading={discountComplianceQuery.isLoading} />}
              <DataTable
                columns={getDiscountBreakdownColumns({ showBranch: false, showProof: canViewDiscountProof })}
                data={visibleDiscountRows}
                isLoading={discountComplianceQuery.isLoading}
                isError={discountComplianceQuery.isError}
                onRetry={() => void discountComplianceQuery.refetch()}
                emptyState={<EmptyState title="No discount types" description="No discounted sales in this date range." />}
              />
            </>
          )}
          <DataTable
            stickyHeader
            columns={getDiscountComplianceColumns(canViewDiscountProof, setDiscountProofTransactionId, employeeNames, discountDetailCustomerIds)}
            data={discountedTransactions}
            isLoading={discountDetailQuery.isLoading}
            isError={discountDetailQuery.isError}
            onRetry={() => void discountDetailQuery.refetch()}
            pagination={discountPagination}
            onPaginationChange={setDiscountPagination}
            rowCount={discountDetailQuery.data?.total ?? discountedTransactions.length}
            emptyState={<EmptyState title="No discounted transactions" description="No discounted transactions in this date range." />}
          />
        </TabsContent>

        <TabsContent value="inventory-movement" className="space-y-4">
          <ReportLastUpdated
            timestamp={movementsQuery.dataUpdatedAt ? new Date(movementsQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={movementsQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Total Movements" value={periodSummary?.movements.total_count ?? 0} valueText={summaryValueText} isLoading={summaryLoading} />
            <KpiCard title="Deliveries / Received" value={periodSummary?.movements.receiving_count ?? 0} valueText={summaryValueText} isLoading={summaryLoading} />
            <KpiCard title="Waste" value={periodSummary?.movements.waste_count ?? 0} valueText={summaryValueText} isLoading={summaryLoading} />
            <KpiCard title="Adjustments" value={periodSummary?.movements.adjustment_count ?? 0} valueText={summaryValueText} isLoading={summaryLoading} />
          </div>
          <ReportCoverageNotice count={movementsQuery.data?.total} noun="stock movements" hasTotals={!summaryUnavailable} />
          <DataTable
            stickyHeader
            columns={inventoryMovementColumns}
            data={movements}
            isLoading={movementsQuery.isLoading}
            isError={movementsQuery.isError}
            onRetry={() => void movementsQuery.refetch()}
            pagination={movementPagination}
            onPaginationChange={setMovementPagination}
            rowCount={movementsQuery.data?.total ?? movements.length}
            emptyState={<EmptyState title="No inventory movements" description="No stock movements recorded in this date range." />}
          />
        </TabsContent>

        <TabsContent value="consumption-summary" className="space-y-4">
          <ReportLastUpdated
            timestamp={consumptionQuery.dataUpdatedAt ? new Date(consumptionQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={consumptionQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Ingredients Used" value={consumptionQuery.data?.total ?? 0} valueText={!canReadReportSummaries || consumptionQuery.isError ? 'Unavailable' : undefined} isLoading={consumptionQuery.isLoading} />
            <KpiCard title="Sales Movements" value={periodSummary?.movements.sale_count ?? 0} valueText={summaryValueText} isLoading={summaryLoading} />
          </div>
          {consumptionQuery.data && (
            <p className="text-sm text-muted-foreground">
              Stock used covers all {(periodSummary?.movements.sale_count ?? 0).toLocaleString('en-PH')} sales movements in this period, across {consumptionQuery.data.total.toLocaleString('en-PH')} ingredients.
            </p>
          )}
          <DataTable
            stickyHeader
            columns={consumptionSummaryColumns}
            data={consumptionRows}
            isLoading={consumptionQuery.isLoading}
            isError={!canReadReportSummaries || consumptionQuery.isError}
            onRetry={() => void consumptionQuery.refetch()}
            pagination={consumptionPagination}
            onPaginationChange={setConsumptionPagination}
            rowCount={consumptionQuery.data?.total ?? consumptionRows.length}
            emptyState={<EmptyState title="No stock used" description="No stock used by sales in this date range." />}
          />
        </TabsContent>

        <TabsContent value="attendance-summary" className="space-y-4">
          <ReportLastUpdated
            timestamp={attendanceQuery.dataUpdatedAt ? new Date(attendanceQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={attendanceQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Attendance Records" value={periodSummary?.attendance.record_count ?? 0} valueText={summaryValueText} isLoading={summaryLoading} />
            <KpiCard title="Crew on Duty" value={periodSummary?.attendance.open_count ?? 0} valueText={summaryValueText} isLoading={summaryLoading} />
            <KpiCard title="Total Hours Worked" value={(periodSummary?.attendance.work_minutes ?? 0) / 60} suffix="h" valueText={summaryValueText} isLoading={summaryLoading} />
            <KpiCard title="Overtime Hours" value={(periodSummary?.attendance.overtime_minutes ?? 0) / 60} suffix="h" valueText={summaryValueText} isLoading={summaryLoading} />
          </div>
          <ReportCoverageNotice count={attendanceQuery.data?.total} noun="attendance records" hasTotals={!summaryUnavailable} />
          <DataTable
            stickyHeader
            columns={attendanceSummaryColumns}
            data={attendanceRecords}
            isLoading={attendanceQuery.isLoading}
            isError={attendanceQuery.isError}
            onRetry={() => void attendanceQuery.refetch()}
            pagination={attendancePagination}
            onPaginationChange={setAttendancePagination}
            rowCount={attendanceQuery.data?.total ?? attendanceRecords.length}
            emptyState={<EmptyState title="No attendance records" description="No time in or time out records in this date range." />}
          />
        </TabsContent>
      </Tabs>

      {isSupervisor && (
        <>
          <ReceiptModal transaction={receiptTransaction ?? null} onClose={() => setReceiptTransactionId(null)} />
          <ViewPaymentProofDialog transactionId={proofTransactionId} onOpenChange={(o) => !o && setProofTransactionId(null)} />
          <ViewDiscountProofDialog transactionId={discountProofTransactionId} onOpenChange={(o) => !o && setDiscountProofTransactionId(null)} />
          <ViewTransactionItemsDialog transaction={viewItemsTransaction} onClose={() => setViewItemsTransaction(null)} />
          <ViewTransactionDetailDialog
            transaction={viewDetailTransaction}
            onClose={() => setViewDetailTransaction(null)}
            branchName={activeBranch?.name ?? null}
            cashierName={
              viewDetailTransaction
                ? (viewDetailTransaction.cashier_name ?? employeeNames.get(viewDetailTransaction.cashier_id) ?? viewDetailTransaction.cashier_id)
                : ''
            }
            attendanceRecords={saleSessionQuery.data?.records ?? []}
          />
        </>
      )}
    </div>
  );
}
