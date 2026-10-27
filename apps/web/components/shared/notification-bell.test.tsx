import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NotificationBell, type NotificationItem } from './notification-bell';

vi.mock('next/link', () => ({
  default: ({ href, children, onClick, className }: { href: string; children: React.ReactNode; onClick?: () => void; className?: string }) => (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
    >
      {children}
    </a>
  ),
}));

afterEach(() => cleanup());

const NOW = Date.now();
function item(id: string, overrides: Partial<NotificationItem> = {}): NotificationItem {
  return { id, type: 'sale_completed', branchId: 'b1', message: 'New Sale', createdAt: new Date(NOW - 60_000).toISOString(), read: false, ...overrides };
}

function open() {
  fireEvent.click(screen.getByRole('button', { name: /Notifications/ }));
}

describe('NotificationBell', () => {
  it('shows the account-wide unread count from the server, not just the loaded rows', () => {
    render(<NotificationBell notifications={[item('a')]} unreadCount={42} />);
    expect(screen.getByRole('button', { name: 'Notifications, 42 unread' })).toBeInTheDocument();
  });

  it('hides the badge at zero', () => {
    render(<NotificationBell notifications={[item('a', { read: true })]} unreadCount={0} />);
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('marks every unread item of a grouped alert read when the group is opened', () => {
    const onMarkRead = vi.fn();
    render(
      <NotificationBell
        notifications={[
          item('x1', { type: 'branch_offline', message: 'Branch Offline', href: '/admin/branches?manage=b1&tab=details' }),
          item('x2', { type: 'branch_offline', message: 'Branch Offline', href: '/admin/branches?manage=b1&tab=details' }),
        ]}
        unreadCount={2}
        onMarkRead={onMarkRead}
      />,
    );
    open();
    expect(screen.getByText('×2')).toBeInTheDocument();
    expect(screen.getByText('No recovery received yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /Branch Offline/ }));
    expect(onMarkRead).toHaveBeenCalledWith(['x1', 'x2']);
  });

  it('filters to unread only', () => {
    render(<NotificationBell notifications={[item('a', { message: 'Unread one' }), item('b', { message: 'Read one', read: true })]} unreadCount={1} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: /^Unread \(/ }));
    expect(screen.getByText('Unread one')).toBeInTheDocument();
    expect(screen.queryByText('Read one')).not.toBeInTheDocument();
  });

  it('keeps the last loaded list on a failed refresh and offers retry', () => {
    const onRetry = vi.fn();
    render(<NotificationBell notifications={[item('a', { message: 'Still here' })]} isError onRetry={onRetry} />);
    open();
    expect(screen.getByText('Still here')).toBeInTheDocument();
    expect(screen.getByText(/Couldn.t refresh/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows a failed-fetch state with retry when nothing has loaded yet', () => {
    render(<NotificationBell notifications={[]} isError onRetry={vi.fn()} />);
    open();
    expect(screen.getByText(/couldn.t be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('shows the reconnecting state separately from the list', () => {
    render(<NotificationBell notifications={[item('a')]} isRealtimeConnected={false} isRealtimeReconnecting />);
    open();
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
  });

  it('marks all as read from the panel header', () => {
    const onMarkAllRead = vi.fn();
    render(<NotificationBell notifications={[item('a')]} unreadCount={1} onMarkAllRead={onMarkAllRead} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: /Mark all as read/ }));
    expect(onMarkAllRead).toHaveBeenCalled();
  });
});
