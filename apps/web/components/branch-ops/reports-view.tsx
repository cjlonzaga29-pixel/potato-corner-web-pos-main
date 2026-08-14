'use client';

import { useEffect, useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type {
  AttendanceResponse,
  ExportReadyPayload,
  ExportRequestInput,
  InventoryStockMovementResponse,
  TransactionResponse,
} from '@potato-corner/shared';
import { toast } from 'sonner';
import { ROLES } from '@potato-corner/shared';
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
import { formatCurrency, formatDateTime, formatDuration, formatInventoryQuantity, formatTimeAgo } from '@/lib/utils';
import { manilaEndOfDayISO, manilaStartOfDayISO } from '@/lib/manila-date';
import { useAuthStore } from '@/stores/auth.store';
import { useBranchStore } from '@/stores/branch.store';
import { useDiscountAuditTrail, useTransaction, useTransactions, useTransactionsRealtimeSync } from '@/hooks/queries/use-transactions';
import { useInventoryItems, useInventoryStockMovements, useInventoryStockRealtimeSync, useUnitsOfMeasure } from '@/hooks/queries/use-universal-inventory';
import { useAttendanceByBranch, useAttendanceRealtimeSync } from '@/hooks/queries/use-attendance';
import { useEmployees } from '@/hooks/queries/use-employees';
import { useDiscountComplianceReport, useRequestExport, useReportsRealtimeSync } from '@/hooks/queries/use-reports';

const DEFAULT_RANGE_DAYS = 7;
const QUERY_LIMIT = 100;
const REFRESH_COOLDOWN_SECONDS = 60;

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

interface ConsumptionSummaryRow {
  inventory_item_id: string;
  inventory_item_name: string;
  unit: string;
  quantity_consumed: number;
  movement_count: number;
}

const consumptionSummaryColumns: ColumnDef<ConsumptionSummaryRow>[] = [
  { accessorKey: 'inventory_item_name', header: 'Ingredient' },
  {
    id: 'quantity_consumed',
    header: 'Consumed',
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
    { id: 'vat_amount', header: 'VAT', cell: ({ row }) => formatCurrency(row.original.vat_amount) },
    { id: 'discount_amount', header: 'Discount', cell: ({ row }) => formatCurrency(row.original.discount_amount) },
    {
      id: 'discount_type',
      header: 'Discount Type',
      cell: ({ row }) => (row.original.discount_type ? humanizeSnake(row.original.discount_type) : '—'),
    },
    { id: 'created_at', header: 'Date', cell: ({ row }) => formatDateTime(row.original.created_at) },
  ];
  if (!withActions) return columns;
  return [
    ...columns,
    {
      // Same PII-visibility boundary as Cashier/Proof Available below
      // (withActions === supervisor only) — sourced from the discount-audit
      // trail endpoint already fetched for the Discount Compliance tab, not
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
 * per product line, so Subtotal/VAT/Discount/Total are never duplicated);
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
    { id: 'vat_amount', header: 'VAT', cell: ({ row }) => formatCurrency(row.original.vat_amount) },
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
      cell: ({ row }) =>
        row.original.discount_type ? <Badge variant="secondary">{humanizeSnake(row.original.discount_type)}</Badge> : '—',
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
      cell: ({ row }) => <Badge variant="outline">{row.original.movement_type}</Badge>,
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
  ];
}

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
 * All queries below are fired unconditionally and in parallel (no
 * sequential/waterfall awaits) so every tab's data is ready by the time the
 * user switches to it, and are capped at limit=100 (the API's max page
 * size) — a known ceiling of this lightweight tier, not a bug: a branch
 * with more than 100 matching rows in the selected range will only
 * aggregate over its most recent 100.
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
  // Task 209.16 — Discount Compliance's Proof Available/View Proof column
  // and KPIs were supervisor-only; the owner explicitly requires Admin
  // (super_admin) to see discount ID proof here too. Scoped to just this
  // tab's `withActions` gate (see getDiscountComplianceColumns below), not
  // every other `isSupervisor` check in this component — those gate
  // unrelated actions this task doesn't touch.
  const isSuperAdmin = useAuthStore((s) => s.user?.role === ROLES.SUPER_ADMIN);
  const canViewDiscountProof = isSupervisor || isSuperAdmin;
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
  const { data: receiptTransaction } = useTransaction(receiptTransactionId);

  // Sold Product Transactions filters (client-side over the fetched page —
  // same known 100-row ceiling as every other tab in this view; none of
  // these are supported query params on GET /api/transactions today).
  const [soldReceiptSearch, setSoldReceiptSearch] = useState('');
  const [soldCashierFilter, setSoldCashierFilter] = useState('all');
  const [soldPaymentMethodFilter, setSoldPaymentMethodFilter] = useState('all');
  const [soldStatusFilter, setSoldStatusFilter] = useState('all');
  const [soldProductFilter, setSoldProductFilter] = useState('all');
  const [soldPagination, setSoldPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

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

  const [fromInput, setFromInput] = useState(() => daysAgoDateString(DEFAULT_RANGE_DAYS));
  const [toInput, setToInput] = useState(() => todayDateString());
  const [dateRange, setDateRange] = useState(() => ({ from: daysAgoDateString(DEFAULT_RANGE_DAYS), to: todayDateString() }));

  const rangeStartISO = startOfDayISO(dateRange.from);
  const rangeEndISO = endOfDayISO(dateRange.to);
  // Inventory Movement's screen data and its PDF export must cover the same
  // window: the export sends a bare date to /api/reports/export, which the
  // backend resolves to a Manila calendar-day boundary (manila-time.ts).
  // This endpoint requires a precise ISO instant, so it's computed the same
  // way client-side instead of via rangeStartISO/rangeEndISO's browser-local
  // midnight, which drifts from Manila whenever the browser isn't on that
  // timezone and desynced the two views.
  const movementRangeStartISO = manilaStartOfDayISO(dateRange.from);
  const movementRangeEndISO = manilaEndOfDayISO(dateRange.to);

  const completedQuery = useTransactions({
    branch_id: activeBranchId ?? undefined,
    status: 'completed',
    date_from: dateRange.from,
    date_to: dateRange.to,
    limit: QUERY_LIMIT,
  });
  // Task 209.56E — the Discount Compliance tab's headline KPIs (total
  // discount amount, discounted-transaction count, PWD/Senior counts) used
  // to be reduced client-side from completedQuery's rows, which are capped
  // at QUERY_LIMIT (100). Any branch/date-range with more than 100 completed
  // transactions silently undercounted every one of those numbers — the
  // same reused reducer must've felt consistent internally but is a real
  // financial-reporting gap. getDiscountCompliance is a SQL groupBy over
  // the full date range (already what Admin Reports uses for the same
  // numbers), so switching these 4 KPIs to it removes the cap without a
  // second discount formula: it's the same discountAmount/discountType
  // columns, aggregated server-side instead of paginated-then-reduced.
  // The detail table and proof-compliance stats below still read from
  // completedQuery, since they need per-transaction rows the aggregate
  // doesn't carry — that page-sized scope is unchanged by this fix.
  const discountComplianceQuery = useDiscountComplianceReport({
    branch_id: activeBranchId ?? undefined,
    date_from: dateRange.from,
    date_to: dateRange.to,
    limit: 25,
  });
  // Task: Discount Compliance parity — reuses the same discount-audit trail
  // endpoint the Admin drilldown already calls (GET /transactions/discount-audit)
  // purely to source discountCustomerId per transaction id, not as this tab's
  // row source (discountedTransactions below is unchanged, so KPIs/detail-row
  // count/CSV/PDF parity with the screen are all unaffected). Gated to
  // canViewDiscountProof so branch/staff sessions never issue this
  // supervisor/admin-only request.
  const discountAuditQuery = useDiscountAuditTrail(
    { branchId: activeBranchId ?? undefined, dateFrom: dateRange.from, dateTo: dateRange.to, page: 1, limit: QUERY_LIMIT },
    canViewDiscountProof,
  );
  // Sold Product Transactions — deliberately not status-filtered (unlike
  // completedQuery above) so the tab's own Status filter can show voided/
  // refunded rows too.
  const soldTransactionsQuery = useTransactions({
    branch_id: activeBranchId ?? undefined,
    date_from: dateRange.from,
    date_to: dateRange.to,
    limit: QUERY_LIMIT,
  });
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
  const movementsQuery = useInventoryStockMovements(activeBranchId, { from_date: movementRangeStartISO, to_date: movementRangeEndISO, page: 1, limit: QUERY_LIMIT });
  const attendanceQuery = useAttendanceByBranch(activeBranchId, { from: rangeStartISO, to: rangeEndISO, page: 1, limit: QUERY_LIMIT });
  const employeesQuery = useEmployees({ branchId: activeBranchId ?? undefined, limit: QUERY_LIMIT });
  const unitsQuery = useUnitsOfMeasure();
  const inventoryItemsQuery = useInventoryItems();

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its reports.</p>;
  }

  function handleRefresh() {
    setDateRange({ from: fromInput, to: toInput });
    setRefreshDisabled(true);
    setRefreshCooldown(REFRESH_COOLDOWN_SECONDS);
  }

  function handleExport(format: 'csv' | 'pdf') {
    const setIsExporting = format === 'csv' ? setIsExportingCsv : setIsExportingPdf;
    setIsExporting(true);
    // Sold Product Transactions shares DAILY_SALES's report_type (no
    // dedicated backend ReportType — see TAB_TO_REPORT_TYPE's comment
    // above) but has its own filter bar; forwarding those filters here is
    // what keeps the CSV/PDF population matching what's on screen for this
    // tab specifically. Every other tab keeps sending just branch/date, same
    // as before.
    const soldTabFilters =
      activeTab === 'sold-product-transactions'
        ? {
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
      },
      format,
    };
    requestExport.mutate(input, { onSettled: () => setIsExporting(false) });
  }

  // Daily Sales
  const completedTransactions = completedQuery.data?.transactions ?? [];
  const totalTransactions = completedTransactions.length;
  // Task 209.10 (Step 11, follow-up A) — this is a sum of total_amount
  // (post-discount, what was actually charged), not the canonical
  // subtotal-based Gross Sales that lib/financial-metrics.ts and the Admin
  // Reports/Financial Summary "Gross Sales" figures use. Left as
  // total_amount rather than switched to subtotal (that's a Gross Sales
  // formula change, out of scope here) — instead labeled "Total Sales"
  // below so it no longer claims to be the same metric.
  const totalSalesCollected = completedTransactions.reduce((sum, t) => sum + t.total_amount, 0);
  const vatCollected = completedTransactions.reduce((sum, t) => sum + t.vat_amount, 0);
  const discountsGiven = completedTransactions.reduce((sum, t) => sum + t.discount_amount, 0);

  // Sold Product Transactions
  const soldTransactionsAll = soldTransactionsQuery.data?.transactions ?? [];
  const soldProductOptions = Array.from(
    new Set(soldTransactionsAll.flatMap((t) => (t.items ?? []).map((i) => i.product_name))),
  ).sort();
  const filteredSoldTransactions = soldTransactionsAll.filter((t) => {
    if (soldCashierFilter !== 'all' && t.cashier_id !== soldCashierFilter) return false;
    if (soldPaymentMethodFilter !== 'all' && t.payment_method !== soldPaymentMethodFilter) return false;
    if (soldStatusFilter !== 'all' && t.status !== soldStatusFilter) return false;
    if (soldProductFilter !== 'all' && !(t.items ?? []).some((i) => i.product_name === soldProductFilter)) return false;
    const search = soldReceiptSearch.trim().toLowerCase();
    if (search && !t.receipt_number.toLowerCase().includes(search)) return false;
    return true;
  });
  const soldTransactionsPageRows = filteredSoldTransactions.slice(
    soldPagination.pageIndex * soldPagination.pageSize,
    soldPagination.pageIndex * soldPagination.pageSize + soldPagination.pageSize,
  );

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

  // Discount Compliance — headline KPIs come from the server-side groupBy
  // aggregate (see discountComplianceQuery above), not the page-capped
  // completedTransactions list. discountedTransactions itself is still
  // needed below for the per-transaction detail table and proof-compliance
  // stats, which the aggregate's rows don't carry.
  const discountedTransactions = completedTransactions.filter((t) => t.discount_type !== null);
  const discountCustomerIdByTransaction = new Map(
    (discountAuditQuery.data?.data ?? []).map((row) => [row.id, row.discountCustomerId]),
  );
  const discountComplianceRows = discountComplianceQuery.data?.data ?? [];
  const totalDiscountedTransactions = discountComplianceRows.reduce((sum, r) => sum + r.transaction_count, 0);
  const pwdDiscounts = discountComplianceRows
    .filter((r) => r.discount_type === 'pwd')
    .reduce((sum, r) => sum + r.transaction_count, 0);
  const seniorCitizenDiscounts = discountComplianceRows
    .filter((r) => r.discount_type === 'senior_citizen')
    .reduce((sum, r) => sum + r.transaction_count, 0);
  const totalDiscountAmount = discountComplianceRows.reduce((sum, r) => sum + r.total_discount_amount, 0);
  // Task 209.5 — compact proof-compliance summary, added to this tab's
  // existing KPI row (no new dashboard widget, no redesign). Proof is only
  // ever meaningful for PWD/Senior Citizen rows — Employee/Promotional
  // discounts have no proof-capture UI, so they're excluded from the
  // denominator rather than counted as "missing".
  const proofEligibleDiscounts = discountedTransactions.filter((t) => t.discount_type === 'pwd' || t.discount_type === 'senior_citizen');
  const proofAvailableCount = proofEligibleDiscounts.filter((t) => t.has_discount_proof).length;
  const proofMissingCount = proofEligibleDiscounts.length - proofAvailableCount;
  const proofComplianceRate = proofEligibleDiscounts.length > 0 ? (proofAvailableCount / proofEligibleDiscounts.length) * 100 : 0;

  // Inventory Movement
  const movements = movementsQuery.data?.movements ?? [];
  const totalMovements = movements.length;
  const receivingCount = movements.filter((m) => m.movement_type === 'RECEIVING').length;
  const wasteCount = movements.filter((m) => m.movement_type === 'WASTE').length;
  const adjustmentsCount = movements.filter((m) => m.movement_type === 'ADJUSTMENT_IN' || m.movement_type === 'ADJUSTMENT_OUT').length;
  const unitCodes = new Map((unitsQuery.data ?? []).map((u) => [u.id, u.code]));
  const itemSkus = new Map((inventoryItemsQuery.data ?? []).map((i) => [i.id, i.sku]));

  // Inventory Consumption Summary — aggregated client-side from the same
  // movements fetch as Inventory Movement above (SALE type only), consistent
  // with this view's client-composed tier. Export still goes through the
  // real backend INVENTORY_CONSUMPTION_SUMMARY aggregate, same relationship
  // Inventory Movement already has with its own export.
  const consumptionByItem = new Map<string, ConsumptionSummaryRow>();
  for (const m of movements) {
    if (m.movement_type !== 'SALE') continue;
    const consumed = Math.abs(m.quantity_change);
    const existing = consumptionByItem.get(m.inventory_item_id);
    if (existing) {
      existing.quantity_consumed += consumed;
      existing.movement_count += 1;
    } else {
      consumptionByItem.set(m.inventory_item_id, {
        inventory_item_id: m.inventory_item_id,
        inventory_item_name: m.inventory_item_name,
        unit: m.unit_id ? (unitCodes.get(m.unit_id) ?? '—') : '—',
        quantity_consumed: consumed,
        movement_count: 1,
      });
    }
  }
  const consumptionRows = Array.from(consumptionByItem.values()).sort((a, b) => b.quantity_consumed - a.quantity_consumed);
  // TASK 209.9: no overall quantity total — consumptionRows mixes grams, kg,
  // and pc across ingredients, so summing quantity_consumed across rows is
  // mathematically meaningless (can't add grams and pieces).
  const totalConsumptionMovements = consumptionRows.reduce((sum, r) => sum + r.movement_count, 0);

  // Attendance Summary
  const attendanceRecords = attendanceQuery.data?.records ?? [];
  const totalStaffToday = attendanceRecords.length;
  const clockedInNow = attendanceRecords.filter((r) => r.clock_out_server_time === null).length;
  const totalWorkMinutes = attendanceRecords.reduce((sum, r) => sum + (r.actual_work_minutes ?? 0), 0);
  const overtimeMinutesSum = attendanceRecords.reduce((sum, r) => sum + r.overtime_minutes, 0);
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
          <TabsTrigger value="daily-sales">Daily Sales</TabsTrigger>
          <TabsTrigger value="sold-product-transactions">Sold Product Transactions</TabsTrigger>
          <TabsTrigger value="void-refund">Void/Refund</TabsTrigger>
          <TabsTrigger value="discount-compliance">Discount Compliance</TabsTrigger>
          <TabsTrigger value="inventory-movement">Inventory Movement</TabsTrigger>
          <TabsTrigger value="consumption-summary">Consumption Summary</TabsTrigger>
          <TabsTrigger value="attendance-summary">Attendance Summary</TabsTrigger>
        </TabsList>

        <TabsContent value="daily-sales" className="space-y-4">
          <ReportLastUpdated
            timestamp={completedQuery.dataUpdatedAt ? new Date(completedQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={completedQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <KpiCard title="Total Transactions" value={totalTransactions} isLoading={completedQuery.isLoading} />
            <KpiCard
              title="Total Sales — Selected Period"
              value={totalSalesCollected}
              prefix="₱"
              isLoading={completedQuery.isLoading}
              tooltip={`Completed transaction totals, after discounts, from ${fromInput} to ${toInput}. For pre-discount Gross Sales, see Admin Reports > Financial Summary.`}
            />
            <KpiCard title="VAT Collected" value={vatCollected} prefix="₱" isLoading={completedQuery.isLoading} />
            <KpiCard title="Discounts Given" value={discountsGiven} prefix="₱" isLoading={completedQuery.isLoading} />
          </div>
          <DataTable
            stickyHeader
            columns={getDailySalesColumns(isSupervisor, setReceiptTransactionId, setProofTransactionId, employeeNames, discountCustomerIdByTransaction)}
            data={completedTransactions}
            isLoading={completedQuery.isLoading}
            isError={completedQuery.isError}
            onRetry={() => void completedQuery.refetch()}
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
            data={soldTransactionsPageRows}
            isLoading={soldTransactionsQuery.isLoading}
            isError={soldTransactionsQuery.isError}
            onRetry={() => void soldTransactionsQuery.refetch()}
            pagination={soldPagination}
            onPaginationChange={setSoldPagination}
            rowCount={filteredSoldTransactions.length}
            emptyState={<EmptyState title="No sold products" description="No product sales match these filters in this date range." />}
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
            stickyHeader
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
            <KpiCard title="Total Discounted Transactions" value={totalDiscountedTransactions} isLoading={discountComplianceQuery.isLoading} />
            <KpiCard title="PWD Discounts" value={pwdDiscounts} isLoading={discountComplianceQuery.isLoading} />
            <KpiCard title="Senior Citizen Discounts" value={seniorCitizenDiscounts} isLoading={discountComplianceQuery.isLoading} />
            <KpiCard title="Total Discount Amount" value={totalDiscountAmount} prefix="₱" isLoading={discountComplianceQuery.isLoading} />
          </div>
          {canViewDiscountProof && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <KpiCard title="Proof Available" value={proofAvailableCount} isLoading={completedQuery.isLoading} />
              <KpiCard title="Proof Missing" value={proofMissingCount} isLoading={completedQuery.isLoading} />
              <KpiCard title="Proof Compliance Rate" value={proofComplianceRate} suffix="%" isLoading={completedQuery.isLoading} />
            </div>
          )}
          <DataTable
            stickyHeader
            columns={getDiscountComplianceColumns(canViewDiscountProof, setDiscountProofTransactionId, employeeNames, discountCustomerIdByTransaction)}
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
            <KpiCard title="Receiving" value={receivingCount} isLoading={movementsQuery.isLoading} />
            <KpiCard title="Waste" value={wasteCount} isLoading={movementsQuery.isLoading} />
            <KpiCard title="Adjustments" value={adjustmentsCount} isLoading={movementsQuery.isLoading} />
          </div>
          <DataTable
            stickyHeader
            columns={inventoryMovementColumns}
            data={movements}
            isLoading={movementsQuery.isLoading}
            isError={movementsQuery.isError}
            onRetry={() => void movementsQuery.refetch()}
            emptyState={<EmptyState title="No inventory movements" description="No stock movements recorded in this date range." />}
          />
        </TabsContent>

        <TabsContent value="consumption-summary" className="space-y-4">
          <ReportLastUpdated
            timestamp={movementsQuery.dataUpdatedAt ? new Date(movementsQuery.dataUpdatedAt).toISOString() : undefined}
            isLoading={movementsQuery.isLoading}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard title="Ingredients Consumed" value={consumptionRows.length} isLoading={movementsQuery.isLoading} />
            <KpiCard title="Sales Movements" value={totalConsumptionMovements} isLoading={movementsQuery.isLoading} />
          </div>
          <DataTable
            stickyHeader
            columns={consumptionSummaryColumns}
            data={consumptionRows}
            isLoading={movementsQuery.isLoading}
            isError={movementsQuery.isError}
            onRetry={() => void movementsQuery.refetch()}
            emptyState={<EmptyState title="No consumption recorded" description="No sale-driven inventory consumption in this date range." />}
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
            stickyHeader
            columns={attendanceSummaryColumns}
            data={attendanceRecords}
            isLoading={attendanceQuery.isLoading}
            isError={attendanceQuery.isError}
            onRetry={() => void attendanceQuery.refetch()}
            emptyState={<EmptyState title="No attendance records" description="No clock-in/out records in this date range." />}
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
            attendanceRecords={attendanceRecords}
          />
        </>
      )}
    </div>
  );
}
