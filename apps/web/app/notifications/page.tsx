'use client';

import { Bell, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '@/hooks/queries/use-notifications';
import { cn, formatTimeAgo } from '@/lib/utils';

const SKELETON_ROWS = 5;

export default function NotificationsPage() {
  const { data: notifications, isLoading, isError, refetch } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const unreadCount = notifications?.filter((notification) => !notification.read).length ?? 0;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">Notifications</h1>
          {unreadCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-semibold text-destructive-foreground">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={unreadCount === 0 || markAllRead.isPending}
          onClick={() => markAllRead.mutate()}
        >
          <Check className="mr-2 h-4 w-4" />
          Mark all as read
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState retry={() => void refetch()} />
      ) : !notifications || notifications.length === 0 ? (
        <EmptyState icon={Bell} title="No notifications" description="You're all caught up." />
      ) : (
        <div className="divide-y rounded-md border">
          {notifications.map((notification) => (
            <button
              key={notification.id}
              type="button"
              onClick={() => !notification.read && markRead.mutate(notification.id)}
              className={cn(
                'flex w-full items-start gap-3 border-l-2 border-l-transparent px-4 py-3 text-left text-sm transition-colors hover:bg-accent',
                !notification.read && 'border-l-primary bg-accent/40',
              )}
            >
              <Bell className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 space-y-0.5">
                <span className={cn('block', !notification.read && 'font-medium')}>{notification.message}</span>
                <span className="block text-xs text-muted-foreground">{formatTimeAgo(notification.createdAt)}</span>
              </span>
              {!notification.read && (
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="unread" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
