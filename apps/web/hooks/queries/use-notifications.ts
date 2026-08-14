'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SOCKET_EVENTS, ROLES } from '@potato-corner/shared';
import {
  ShoppingCart,
  Undo2,
  ShieldAlert,
  Receipt,
  PackagePlus,
  Trash2,
  ArrowLeftRight,
  AlertTriangle,
  PackageX,
  Ban,
  Clock,
  WifiOff,
  Wifi,
  CalendarClock,
  type LucideIcon,
} from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';
import { useAuthStore } from '@/stores/auth.store';
import { formatCurrency } from '@/lib/utils';
import type { NotificationItem, NotificationSeverity } from '@/components/shared/notification-bell';

interface NotificationRow {
  id: string;
  type: string;
  payload: unknown;
  branch_id: string;
  branch_name: string | null;
  read: boolean;
  created_at: string;
}

interface NotificationListResponse {
  notifications: NotificationRow[];
  total: number;
  unread_count: number;
  page: number;
  limit: number;
}

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorMessage(response: ApiErrorShape, fallback: string): string {
  if (!response.error) return fallback;
  return typeof response.error === 'string' ? response.error : (response.error.message ?? response.error.code);
}

/** Loosely-typed read of a JSON payload column — every field is optionally present, never trusted beyond presentation. */
type Payload = Record<string, unknown>;

function str(payload: Payload, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function num(payload: Payload, key: string): number {
  const value = payload[key];
  return typeof value === 'number' ? value : 0;
}

/**
 * Task 220 — role-aware click target. Each role's dashboard lives under its
 * own route group ((admin)/admin, (supervisor)/supervisor, (branch)/branch)
 * with its own subset of pages (e.g. only branch has /sales, only admin has
 * /shifts) — this reuses those EXISTING routes rather than inventing a new
 * notification-detail page. Returns null (no navigation) when a role has no
 * matching page for the event, rather than guessing a route that may 404.
 */
function hrefFor(type: string, role: string | undefined): string | undefined {
  const base = role === ROLES.SUPER_ADMIN ? '/admin' : role === ROLES.SUPERVISOR ? '/supervisor' : role === ROLES.BRANCH ? '/branch' : null;
  if (!base) return undefined;
  switch (type) {
    case 'sale_completed':
    case 'refund_completed':
    case 'discount_compliance_flagged':
    case 'void_requested':
      return base === '/branch' ? `${base}/sales` : `${base}/reports`;
    case 'low_stock':
    case 'critical_stock':
    case 'out_of_stock':
    case 'receiving_recorded':
    case 'waste_recorded':
    case 'transfer_completed':
    case 'inventory_deduction_failed':
    case 'large_adjustment_approval_needed':
      return `${base}/inventory`;
    case 'product_auto_unavailable':
      return `${base}/products`;
    case 'expense_created':
      return `${base}/expenses`;
    case 'cash_variance_flagged':
      return base === '/admin' ? `${base}/shifts` : `${base}/cash`;
    case 'eod_summary':
      return base === '/admin' ? `${base}/reports` : undefined;
    default:
      return undefined;
  }
}

/**
 * Task 220 — one description per notification type: icon, severity (B11:
 * normal/warning/critical, not everything red), title, and a short detail
 * line. Purely presentational — every amount/name here is read verbatim
 * from the payload the backend already computed; nothing is recalculated.
 */
function describe(row: NotificationRow): { icon: LucideIcon; severity: NotificationSeverity; title: string; detail: string } {
  const p = (row.payload ?? {}) as Payload;
  switch (row.type) {
    case 'sale_completed':
      return { icon: ShoppingCart, severity: 'normal', title: 'New Sale', detail: `${formatCurrency(num(p, 'amount'))} • ${str(p, 'paymentMethod') || 'cash'}` };
    case 'refund_completed':
      return { icon: Undo2, severity: 'critical', title: 'Refund Completed', detail: `${str(p, 'transactionNumber')} • ${formatCurrency(num(p, 'amount'))}` };
    case 'discount_compliance_flagged':
      return {
        icon: ShieldAlert,
        severity: 'warning',
        title: 'Discount Missing Proof',
        detail: `${str(p, 'discountType') || 'Discount'} • ${str(p, 'transactionNumber')}`,
      };
    case 'expense_created':
      return { icon: Receipt, severity: 'normal', title: 'Expense Added', detail: `${formatCurrency(num(p, 'amount'))} • ${str(p, 'category') || 'Expense'}` };
    case 'receiving_recorded':
      return { icon: PackagePlus, severity: 'normal', title: 'Stock Received', detail: `${str(p, 'ingredientName')} +${num(p, 'quantityChange')}` };
    case 'waste_recorded':
      return { icon: Trash2, severity: 'warning', title: 'Waste Recorded', detail: `${str(p, 'ingredientName')} • ${str(p, 'reasonCode') || 'waste'}` };
    case 'transfer_completed':
      return {
        icon: ArrowLeftRight,
        severity: 'normal',
        title: str(p, 'direction') === 'incoming' ? 'Transfer Received' : 'Transfer Sent',
        detail: `${str(p, 'ingredientName')} ×${num(p, 'quantity')}`,
      };
    case 'low_stock':
      return { icon: AlertTriangle, severity: 'warning', title: 'Low Stock', detail: `${str(p, 'ingredientName')} is running low.` };
    case 'critical_stock':
      return { icon: AlertTriangle, severity: 'warning', title: 'Critical Stock', detail: `${str(p, 'ingredientName')} is critically low.` };
    case 'out_of_stock':
      return { icon: PackageX, severity: 'critical', title: 'Out of Stock', detail: `${str(p, 'ingredientName')} is out of stock.` };
    case 'product_auto_unavailable':
      return { icon: PackageX, severity: 'critical', title: 'Product Unavailable', detail: `Caused by ${str(p, 'triggeredByIngredientName')}.` };
    case 'cash_variance_flagged':
      return { icon: AlertTriangle, severity: 'warning', title: 'Cash Variance', detail: `Variance ${formatCurrency(num(p, 'variance'))}` };
    case 'void_requested':
      return { icon: Ban, severity: 'warning', title: 'Void Requested', detail: `${formatCurrency(num(p, 'amount'))}` };
    case 'large_adjustment_approval_needed':
      return { icon: Clock, severity: 'warning', title: 'Adjustment Needs Approval', detail: formatCurrency(num(p, 'amount')) };
    case 'fraud_alert_created':
      return { icon: ShieldAlert, severity: 'critical', title: 'Fraud Alert', detail: str(p, 'severity') || 'Review required' };
    case 'inventory_deduction_failed':
      return { icon: AlertTriangle, severity: 'critical', title: 'Inventory Deduction Failed', detail: 'A sale could not deduct stock.' };
    case 'offline_transactions_synced':
      return { icon: Wifi, severity: 'normal', title: 'Offline Sales Synced', detail: `${num(p, 'syncedCount')} transaction(s)` };
    case 'eod_summary':
      return { icon: CalendarClock, severity: 'normal', title: 'End-of-Day Summary', detail: str(p, 'businessDate') || 'Ready' };
    case 'branch_offline':
      return { icon: WifiOff, severity: 'warning', title: 'Branch Offline', detail: str(p, 'branchName') || 'No active connection' };
    case 'branch_online':
      return { icon: Wifi, severity: 'normal', title: 'Branch Online', detail: str(p, 'branchName') || 'Back online' };
    default:
      return { icon: AlertTriangle, severity: 'normal', title: row.type, detail: '' };
  }
}

function toItem(row: NotificationRow, role: string | undefined): NotificationItem {
  const { icon, severity, title, detail } = describe(row);
  return {
    id: row.id,
    icon,
    severity,
    message: title,
    branchName: row.branch_name ?? undefined,
    detail,
    createdAt: row.created_at,
    read: row.read,
    href: hrefFor(row.type, role),
  };
}

/**
 * page/limit default to the bell dropdown's original fixed first-page-of-25
 * behavior — only NotificationsPageContent's full list view passes explicit
 * pagination state.
 */
export function useNotifications(page = 1, limit = 25) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const isLoading = useAuthStore((s) => s.isLoading);
  const role = useAuthStore((s) => s.user?.role);

  const query = useQuery({
    queryKey: ['notifications', page, limit],
    queryFn: async () => {
      const response = await apiClient<NotificationListResponse>(`/api/notifications?page=${page}&limit=${limit}`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load notifications'));
      return { rows: response.data.notifications, total: response.data.total };
    },
    staleTime: 15_000,
    enabled: !!accessToken && !isLoading,
  });

  // Task 220 — item shaping (icon/severity/href) depends on `role`, which
  // doesn't change the React Query cache key; memoized separately so a
  // role-independent cache hit doesn't redo this mapping needlessly, and so
  // this never triggers a network refetch of its own (see B16 — one
  // notification must not rerender the entire POS catalog).
  const items = useMemo(() => query.data?.rows.map((row) => toItem(row, role)), [query.data, role]);

  return { ...query, data: items ? { items, total: query.data?.total ?? 0 } : undefined };
}

export function useNotificationsRealtimeSync(): void {
  useRealtimeInvalidate(
    [
      SOCKET_EVENTS.INVENTORY_LOW_STOCK,
      SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK,
      SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE,
      SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED,
      SOCKET_EVENTS.CASH_VARIANCE_FLAGGED,
      SOCKET_EVENTS.VOID_REQUESTED,
      SOCKET_EVENTS.FRAUD_ALERT_CREATED,
      SOCKET_EVENTS.LARGE_ADJUSTMENT_APPROVAL_NEEDED,
      SOCKET_EVENTS.OFFLINE_TRANSACTIONS_SYNCED,
      SOCKET_EVENTS.EOD_SUMMARY,
      SOCKET_EVENTS.BRANCH_OFFLINE,
      // Task 220 — new operational-visibility event types ride the SAME
      // socket events their originating service call site already
      // broadcasts (transaction/expense/inventory-movement), so no new
      // socket event names were introduced; this only widens the
      // invalidation trigger list to include them.
      SOCKET_EVENTS.TRANSACTION_COMPLETED,
      SOCKET_EVENTS.TRANSACTION_REFUNDED,
      SOCKET_EVENTS.EXPENSE_CREATED,
    ],
    [['notifications']],
  );
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await apiClient(`/api/notifications/${id}/read`, { method: 'PATCH' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to mark notification read'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient('/api/notifications/read-all', { method: 'PATCH' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to mark all notifications read'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
