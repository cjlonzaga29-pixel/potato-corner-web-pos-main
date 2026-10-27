'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Bell, Check, ChevronDown, ChevronUp, RefreshCw, WifiOff, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from './feedback/empty-state';
import { cn, formatTimeAgo } from '@/lib/utils';
import { groupNotifications, type NotificationGroup } from '@/lib/notification-groups';

/** Task 220 — subtle hierarchy (B11): not every notification is red. */
export type NotificationSeverity = 'normal' | 'warning' | 'critical';

export interface NotificationItem {
  id: string;
  /** Backend notification type — used only for grouping repeats (POS-PERF-P40). */
  type?: string;
  branchId?: string;
  subjectKey?: string;
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
  /** Account-wide unread count from the server. Falls back to the loaded rows when absent. */
  unreadCount?: number;
  isLoading?: boolean;
  isError?: boolean;
  isRefreshing?: boolean;
  onRetry?: () => void;
  /** Time of the last SUCCESSFUL fetch — a failed refresh never moves it. */
  lastUpdatedAt?: Date | null;
  /** Realtime connection state — separate from notification preferences. */
  isRealtimeConnected?: boolean;
  isRealtimeReconnecting?: boolean;
  onMarkRead?: (ids: string[]) => void;
  onMarkAllRead?: () => void;
}

type ReadFilter = 'all' | 'unread';

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

type BellItem = NotificationItem & { type: string; branchId: string; subjectKey: string; createdAt: string };

function toGroupable(item: NotificationItem): BellItem {
  return {
    ...item,
    // An item without a type never groups (its id is unique).
    type: item.type ?? item.id,
    branchId: item.branchId ?? '',
    subjectKey: item.subjectKey ?? '',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : item.createdAt.toISOString(),
  };
}

/**
 * Presentational only — the caller owns fetching, the realtime subscription
 * and the read mutations. Interaction model (POS-PERF-P40): a bell with an
 * unread badge, a panel with All / Unread, Mark all as read in the panel
 * header, unread rows marked by a dot AND bold text (not color alone),
 * clicking a row opens its destination and marks it (or its whole group)
 * read, and read notifications stay in the list rather than disappearing.
 */
export function NotificationBell({
  notifications = [],
  unreadCount: serverUnreadCount,
  isLoading = false,
  isError = false,
  isRefreshing = false,
  onRetry,
  lastUpdatedAt = null,
  isRealtimeConnected = true,
  isRealtimeReconnecting = false,
  onMarkRead,
  onMarkAllRead,
}: NotificationBellProps) {
  const [filter, setFilter] = useState<ReadFilter>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const unreadCount = serverUnreadCount ?? notifications.filter((notification) => !notification.read).length;

  const groups = useMemo(() => groupNotifications(notifications.map(toGroupable)), [notifications]);
  const visibleGroups = filter === 'unread' ? groups.filter((group) => group.unreadCount > 0) : groups;
  const badgeLabel = unreadCount > 99 ? '99+' : String(unreadCount);

  function renderGroup(group: NotificationGroup<BellItem>) {
    const notification = group.latest;
    const Icon = notification.icon ?? Bell;
    const severity = notification.severity ?? 'normal';
    const isUnread = group.unreadCount > 0;
    const count = group.items.length;
    const isExpanded = expanded[group.key] ?? false;
    const unreadIds = group.items.filter((item) => !item.read).map((item) => item.id);

    const rowClassName = cn(
      'flex w-full min-w-0 items-start gap-3 border-l-2 border-l-transparent px-4 py-3 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
      isUnread && SEVERITY_BORDER_CLASS[severity],
      isUnread && 'bg-accent/40',
    );
    // Recovery is only claimed from an actual branch_online notification newer than the outage.
    const recoveryLine =
      notification.type === 'branch_offline'
        ? group.recoveredBy
          ? `Back online ${formatTimeAgo(group.recoveredBy.createdAt)}`
          : 'No recovery received yet'
        : null;
    const body = (
      <>
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', SEVERITY_ICON_CLASS[severity])} aria-hidden="true" />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className={cn('flex items-center gap-1.5', isUnread && 'font-semibold')}>
            <span className="truncate">{notification.message}</span>
            {count > 1 && <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">×{count}</span>}
          </span>
          {notification.branchName && <span className="block truncate text-xs text-muted-foreground">{notification.branchName}</span>}
          {notification.detail && notification.detail !== notification.branchName && <span className="block truncate text-xs text-muted-foreground">{notification.detail}</span>}
          {recoveryLine && <span className="block text-xs text-muted-foreground">{recoveryLine}</span>}
          <span className="block text-xs text-muted-foreground">
            {count > 1 ? `Latest ${formatTimeAgo(notification.createdAt)}` : formatTimeAgo(notification.createdAt)}
          </span>
        </span>
        {isUnread && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
        <span className="sr-only">{isUnread ? 'Unread.' : 'Read.'}</span>
      </>
    );
    const markGroupRead = () => {
      if (unreadIds.length > 0) onMarkRead?.(unreadIds);
    };

    return (
      <li key={group.key} className="border-b last:border-b-0">
        {notification.href ? (
          <Link href={notification.href} onClick={markGroupRead} className={rowClassName}>
            {body}
          </Link>
        ) : (
          <button type="button" onClick={markGroupRead} className={rowClassName}>
            {body}
          </button>
        )}
        {count > 1 && (
          <div className="px-4 pb-2">
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:underline focus-visible:outline-none"
              aria-expanded={isExpanded}
              onClick={() => setExpanded((prev) => ({ ...prev, [group.key]: !isExpanded }))}
            >
              {isExpanded ? <ChevronUp className="h-3 w-3" aria-hidden="true" /> : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
              {isExpanded ? 'Hide' : 'Show'} all {count}
            </button>
            {isExpanded && (
              <ul className="mt-1 space-y-1 border-l pl-3">
                {group.items.map((item) => (
                  <li key={item.id} className={cn('text-xs', item.read ? 'text-muted-foreground' : 'font-medium')}>
                    {formatTimeAgo(item.createdAt)}
                    {item.detail ? ` · ${item.detail}` : ''}
                    {!item.read && <span className="sr-only"> (unread)</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </li>
    );
  }

  let content: React.ReactNode;
  if (isLoading && notifications.length === 0) {
    content = (
      <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading notifications">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else if (isError && notifications.length === 0) {
    content = (
      <div className="space-y-2 p-4 text-sm" role="alert">
        <p>Notifications couldn&apos;t be loaded.</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
            Try again
          </Button>
        )}
      </div>
    );
  } else if (visibleGroups.length === 0) {
    content =
      filter === 'unread' ? (
        <EmptyState title="No unread notifications" description="You're all caught up." />
      ) : (
        <EmptyState title="No notifications" description="You're all caught up." />
      );
  } else {
    content = <ul aria-label="Notification list">{visibleGroups.map(renderGroup)}</ul>;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}>
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground"
            >
              {badgeLabel}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-1rem)] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <p className="text-sm font-semibold">
            Notifications
            <span className="sr-only" aria-live="polite">
              {unreadCount > 0 ? `, ${unreadCount} unread` : ', none unread'}
            </span>
          </p>
          {unreadCount > 0 && onMarkAllRead && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onMarkAllRead}>
              <Check className="mr-1 h-3 w-3" aria-hidden="true" />
              Mark all as read
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1 border-b px-3 py-1.5" role="group" aria-label="Filter notifications">
          {(['all', 'unread'] as const).map((value) => (
            <Button
              key={value}
              variant={filter === value ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 text-xs"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? 'All' : `Unread${unreadCount > 0 ? ` (${badgeLabel})` : ''}`}
            </Button>
          ))}
        </div>
        {(!isRealtimeConnected || isRealtimeReconnecting) && (
          <p className="flex items-center gap-1.5 border-b bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground" role="status">
            <WifiOff className="h-3 w-3" aria-hidden="true" />
            {isRealtimeReconnecting ? 'Reconnecting — new alerts may be delayed.' : 'Live updates paused — showing the last loaded list.'}
          </p>
        )}
        {isError && notifications.length > 0 && (
          <p className="flex items-center justify-between gap-2 border-b bg-destructive/5 px-4 py-1.5 text-xs" role="alert">
            Couldn&apos;t refresh. Showing the last loaded list.
            {onRetry && (
              <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={onRetry}>
                Retry
              </button>
            )}
          </p>
        )}
        <div className="max-h-96 overflow-y-auto">{content}</div>
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            {isRefreshing ? 'Refreshing…' : lastUpdatedAt ? `Updated ${formatTimeAgo(lastUpdatedAt)}` : ''}
          </span>
          <Button variant="ghost" size="sm" className="text-xs" asChild>
            <Link href="/notifications">View all notifications</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
