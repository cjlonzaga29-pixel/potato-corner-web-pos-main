'use client';

import Link from 'next/link';
import { Bell, Check, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { EmptyState } from './feedback/empty-state';
import { cn, formatTimeAgo } from '@/lib/utils';

export interface NotificationItem {
  id: string;
  icon?: LucideIcon;
  message: string;
  createdAt: string | Date;
  read: boolean;
}

interface NotificationBellProps {
  notifications?: NotificationItem[];
  onMarkRead?: (id: string) => void;
  onMarkAllRead?: () => void;
}

/**
 * Presentational only — real-time delivery comes from the socket
 * 'notification' event (see hooks/use-socket.ts); the caller owns that
 * subscription and passes the resulting list down as `notifications`.
 */
export function NotificationBell({ notifications = [], onMarkRead, onMarkAllRead }: NotificationBellProps) {
  const unreadCount = notifications.filter((notification) => !notification.read).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <p className="text-sm font-semibold">Notifications</p>
          {unreadCount > 0 && onMarkAllRead && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onMarkAllRead}>
              <Check className="mr-1 h-3 w-3" />
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {notifications.length === 0 ? (
            <EmptyState title="No notifications" description="You're all caught up." />
          ) : (
            notifications.map((notification) => {
              const Icon = notification.icon ?? Bell;
              return (
                <button
                  key={notification.id}
                  type="button"
                  onClick={() => onMarkRead?.(notification.id)}
                  className={cn(
                    'flex w-full items-start gap-3 border-b border-l-2 border-l-transparent px-4 py-3 text-left text-sm transition-colors last:border-b-0 hover:bg-accent',
                    !notification.read && 'border-l-primary bg-accent/40',
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 space-y-0.5">
                    <span className={cn('block', !notification.read && 'font-medium')}>{notification.message}</span>
                    <span className="block text-xs text-muted-foreground">{formatTimeAgo(notification.createdAt)}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="border-t p-2">
          <Button variant="ghost" size="sm" className="w-full text-xs" asChild>
            <Link href="/notifications">View all notifications</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
