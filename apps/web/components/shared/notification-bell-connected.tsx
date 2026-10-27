'use client';

import { NotificationBell } from './notification-bell';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useNotificationsRealtimeSync,
} from '@/hooks/queries/use-notifications';
import { useSocketStore } from '@/stores/socket.store';

export function NotificationBellConnected() {
  const { data, isLoading, isError, isFetching, refetch, lastSuccessfulFetchAt } = useNotifications();
  useNotificationsRealtimeSync();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const isConnected = useSocketStore((s) => s.isConnected);
  const isReconnecting = useSocketStore((s) => s.isReconnecting);

  return (
    <NotificationBell
      notifications={data?.items}
      unreadCount={data?.unreadCount}
      isLoading={isLoading}
      isError={isError}
      isRefreshing={isFetching && !isLoading}
      onRetry={() => void refetch()}
      lastUpdatedAt={lastSuccessfulFetchAt}
      isRealtimeConnected={isConnected}
      isRealtimeReconnecting={isReconnecting}
      onMarkRead={(ids) => markRead.mutate(ids)}
      onMarkAllRead={() => markAllRead.mutate()}
    />
  );
}
