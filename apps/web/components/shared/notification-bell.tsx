'use client';

import Link from 'next/link';
import { Bell, Check, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { EmptyState } from './feedback/empty-state';
import { cn, formatTimeAgo } from '@/lib/utils';

/** Task 220 — subtle hierarchy (B11): not every notification is red. */
export type NotificationSeverity = 'normal' | 'warning' | 'critical';

export interface NotificationItem {
  id: string;
  icon?: LucideIcon;
  severity?: NotificationSeverity;
  message: string;
  /** Branch this event belongs to — shown so an admin/supervisor row identifies its branch (B4). */
  branchName?: string;
  /** Short second line (amount, item name, etc.) — never a recomputed price, always read from the event payload. */
  detail?: string;
  createdAt: string | Date;
  read: boolean;
  /** Existing route to navigate to on click (B13) — never a new detail page. */
  href?: string;
}

interface NotificationBellProps {
  notifications?: NotificationItem[];
  onMarkRead?: (id: string) => void;
  onMarkAllRead?: () => void;
}

const SEVERITY_ICON_CLASS: Record<NotificationSeverity, string> = {
  normal: 'text-muted-foreground',
  warning: 'text-warning',
  critical: 'text-destructive',
};

const SEVERITY_BORDER_CLASS: Record<NotificationSeverity, string> = {
  normal: 'border-l-primary',
  warning: 'border-l-warning',
  critical: 'border-l-destructive',
};

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
              const severity = notification.severity ?? 'normal';
              const rowClassName = cn(
                'flex w-full items-start gap-3 border-b border-l-2 border-l-transparent px-4 py-3 text-left text-sm transition-colors last:border-b-0 hover:bg-accent',
                !notification.read && SEVERITY_BORDER_CLASS[severity],
                !notification.read && 'bg-accent/40',
              );
              const body = (
                <>
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', SEVERITY_ICON_CLASS[severity])} aria-hidden="true" />
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className={cn('block', !notification.read && 'font-medium')}>{notification.message}</span>
                    {notification.branchName && <span className="block truncate text-xs text-muted-foreground">{notification.branchName}</span>}
                    {notification.detail && <span className="block truncate text-xs text-muted-foreground">{notification.detail}</span>}
                    <span className="block text-xs text-muted-foreground">{formatTimeAgo(notification.createdAt)}</span>
                  </span>
                </>
              );
              // Task 220 — clicking marks read AND (when the event has a matching
              // existing page for this role) navigates there; a Link is used
              // instead of a button so it's a real navigable anchor (right-click
              // "open in new tab" keeps working) rather than programmatic-only nav.
              return notification.href ? (
                <Link key={notification.id} href={notification.href} onClick={() => onMarkRead?.(notification.id)} className={rowClassName}>
                  {body}
                </Link>
              ) : (
                <button key={notification.id} type="button" onClick={() => onMarkRead?.(notification.id)} className={rowClassName}>
                  {body}
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
