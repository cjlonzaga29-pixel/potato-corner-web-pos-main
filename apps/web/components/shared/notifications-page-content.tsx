'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Bell, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { ROLE_DASHBOARDS } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { useAuth } from '@/hooks/use-auth';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '@/hooks/queries/use-notifications';
import { cn, formatTimeAgo } from '@/lib/utils';

const SKELETON_ROWS = 5;
const PAGE_SIZE = 25;

type ReadFilter = 'all' | 'unread' | 'read';

/**
 * Shared body behind the top-level `/notifications` route (reached from the
 * notification bell's "View all notifications" link on every role, which is
 * not nested inside any of the three dashboard shells and therefore has no
 * sidebar/header of its own) and `/branch/notifications` (which does sit
 * inside the branch shell already, via the sidebar's Notifications item).
 * The back link + breadcrumb render unconditionally so the bare route always
 * has a way home; on the branch route that's simply a redundant-but-harmless
 * second way back, never a broken or empty one.
 */
export function NotificationsPageContent() {
  const { user } = useAuth();
  const backHref = user ? ROLE_DASHBOARDS[user.role] : '/login';

  const [page, setPage] = useState(1);
  const [readFilter, setReadFilter] = useState<ReadFilter>('all');
  const [search, setSearch] = useState('');
  const { data, isLoading, isError, refetch } = useNotifications(page, PAGE_SIZE);
  const notifications = data?.items;
  const total = data?.total ?? 0;
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const unreadCount = notifications?.filter((notification) => !notification.read).length ?? 0;

  // Filters/search apply only to the currently-loaded page of real
  // notifications from useNotifications — no fabricated data, and no new
  // query params, so pagination/mark-read/mark-all-read behavior against the
  // API is unaffected.
  const visibleNotifications = useMemo(() => {
    if (!notifications) return notifications;
    const query = search.trim().toLowerCase();
    return notifications.filter((notification) => {
      if (readFilter === 'unread' && notification.read) return false;
      if (readFilter === 'read' && !notification.read) return false;
      if (query && !notification.message.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [notifications, readFilter, search]);

  const isFiltered = readFilter !== 'all' || search.trim().length > 0;

  return (
    <div className="app-page mx-auto max-w-2xl app-section app-section-gap">
      <div className="space-y-2">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={backHref}>Dashboard</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Notifications</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href={backHref}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to dashboard
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="app-title font-bold">Notifications</h1>
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

      <div className="app-toolbar">
        <div role="group" aria-label="Filter by read status" className="flex items-center gap-1 rounded-xl bg-muted/70 p-1">
          {(
            [
              { value: 'all', label: 'All' },
              { value: 'unread', label: 'Unread' },
              { value: 'read', label: 'Read' },
            ] as const
          ).map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={readFilter === option.value ? 'default' : 'ghost'}
              aria-pressed={readFilter === option.value}
              className="h-7 rounded-lg px-3"
              onClick={() => setReadFilter(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search notifications…"
          className="w-full sm:max-w-xs"
        />
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
      ) : !visibleNotifications || visibleNotifications.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No matching notifications"
          description={isFiltered ? 'Try a different filter or search term.' : "You're all caught up."}
        />
      ) : (
        <div className="divide-y rounded-md border">
          {visibleNotifications.map((notification) => (
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

      {!isLoading && !isError && pageCount > 1 && (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Page {page} of {pageCount} · {total} total
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(p - 1, 1))}
              disabled={page <= 1}
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(p + 1, pageCount))}
              disabled={page >= pageCount}
            >
              Next
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
