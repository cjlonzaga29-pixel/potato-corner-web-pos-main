'use client';

import { NotificationBell } from './notification-bell';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useNotificationsRealtimeSync,
} from '@/hooks/queries/use-notifications';

export function NotificationBellConnected() {
  const { data } = useNotifications();
  useNotificationsRealtimeSync();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  return (
    <NotificationBell
      notifications={data?.items}
      onMarkRead={(id) => markRead.mutate(id)}
      onMarkAllRead={() => markAllRead.mutate()}
    />
  );
}
