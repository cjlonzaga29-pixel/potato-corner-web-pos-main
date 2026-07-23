'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';
import { useAuthStore } from '@/stores/auth.store';
import type { NotificationItem } from '@/components/shared/notification-bell';

interface NotificationRow {
  id: string;
  type: string;
  payload: unknown;
  branch_id: string;
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

const MESSAGE_BY_TYPE: Record<string, string> = {
  low_stock: 'An ingredient is running low on stock.',
  critical_stock: 'An ingredient has reached critical stock levels.',
  out_of_stock: 'An ingredient is out of stock.',
  product_auto_unavailable: 'A product was automatically marked unavailable.',
  cash_variance_flagged: 'A shift cash variance was flagged.',
  void_requested: 'A transaction void was requested.',
  large_adjustment_approval_needed: 'A large adjustment needs approval.',
  fraud_alert_created: 'A new fraud alert was created.',
  inventory_deduction_failed: 'Inventory deduction failed for a transaction.',
  offline_transactions_synced: 'Offline transactions were synced.',
  eod_summary: 'End-of-day summary is ready.',
  branch_offline: 'A branch went offline.',
};

function toItem(row: NotificationRow): NotificationItem {
  return {
    id: row.id,
    message: MESSAGE_BY_TYPE[row.type] ?? row.type,
    createdAt: row.created_at,
    read: row.read,
  };
}

export function useNotifications() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const isLoading = useAuthStore((s) => s.isLoading);

  return useQuery({
    queryKey: ['notifications'],
    queryFn: async () => {
      const response = await apiClient<NotificationListResponse>('/api/notifications?page=1&limit=25');
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load notifications'));
      return response.data.notifications.map(toItem);
    },
    staleTime: 15_000,
    enabled: !!accessToken && !isLoading,
  });
}

export function useNotificationsRealtimeSync(): void {
  useRealtimeInvalidate(
    [
      SOCKET_EVENTS.INVENTORY_LOW_STOCK,
      SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK,
      SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE,
      SOCKET_EVENTS.CASH_VARIANCE_FLAGGED,
      SOCKET_EVENTS.VOID_REQUESTED,
      SOCKET_EVENTS.FRAUD_ALERT_CREATED,
      SOCKET_EVENTS.LARGE_ADJUSTMENT_APPROVAL_NEEDED,
      SOCKET_EVENTS.OFFLINE_TRANSACTIONS_SYNCED,
      SOCKET_EVENTS.EOD_SUMMARY,
      SOCKET_EVENTS.BRANCH_OFFLINE,
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
