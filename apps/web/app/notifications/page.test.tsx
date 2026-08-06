import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import NotificationsPage from './page';
import type { NotificationItem } from '@/components/shared/notification-bell';

const {
  mockUseNotifications,
  mockUseMarkNotificationRead,
  mockUseMarkAllNotificationsRead,
  mockMarkAllMutate,
  mockUseAuth,
} = vi.hoisted(() => ({
  mockUseNotifications: vi.fn(),
  mockUseMarkNotificationRead: vi.fn(),
  mockUseMarkAllNotificationsRead: vi.fn(),
  mockMarkAllMutate: vi.fn(),
  mockUseAuth: vi.fn(),
}));

vi.mock('@/hooks/queries/use-notifications', () => ({
  useNotifications: mockUseNotifications,
  useMarkNotificationRead: mockUseMarkNotificationRead,
  useMarkAllNotificationsRead: mockUseMarkAllNotificationsRead,
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

function notification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'notif-1',
    message: 'An ingredient is running low on stock.',
    createdAt: '2026-07-22T00:00:00.000Z',
    read: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

interface NotificationsQueryOverrides {
  items?: NotificationItem[];
  isLoading?: boolean;
  isError?: boolean;
}

function setup(overrides: NotificationsQueryOverrides = {}) {
  const { items = [notification()], ...rest } = overrides;
  mockUseNotifications.mockReturnValue({
    data: { items, total: items.length },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...rest,
  });
  mockUseMarkNotificationRead.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseMarkAllNotificationsRead.mockReturnValue({ mutate: mockMarkAllMutate, isPending: false });
  mockUseAuth.mockReturnValue({ user: { role: 'branch' } });
}

describe('NotificationsPage', () => {
  it('renders a loading skeleton while notifications are loading', () => {
    setup({ isLoading: true });

    const { container } = render(<NotificationsPage />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders the empty state when there are no notifications', () => {
    setup({ items: [] });

    render(<NotificationsPage />);

    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });

  it('renders the notification list when notifications are present', () => {
    setup({ items: [notification({ message: 'An ingredient is running low on stock.' })] });

    render(<NotificationsPage />);

    expect(screen.getByText('An ingredient is running low on stock.')).toBeInTheDocument();
  });

  it('disables "Mark all as read" when there are 0 unread notifications', () => {
    setup({ items: [notification({ read: true })] });

    render(<NotificationsPage />);

    expect(screen.getByRole('button', { name: /Mark all as read/ })).toBeDisabled();
  });

  it('enables "Mark all as read" and triggers the mutation when there are unread notifications', () => {
    setup({ items: [notification({ read: false })] });

    render(<NotificationsPage />);

    const button = screen.getByRole('button', { name: /Mark all as read/ });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(mockMarkAllMutate).toHaveBeenCalledTimes(1);
  });

  it('does not render pagination controls when everything fits on one page', () => {
    setup({ items: [notification()] });

    render(<NotificationsPage />);

    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
  });

  it('shows pagination controls and requests the next page when there are more results than fit on one page', () => {
    const items = Array.from({ length: 25 }, (_, i) => notification({ id: `notif-${i}` }));
    mockUseNotifications.mockReturnValue({
      data: { items, total: 30 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockUseMarkNotificationRead.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseMarkAllNotificationsRead.mockReturnValue({ mutate: mockMarkAllMutate, isPending: false });
    mockUseAuth.mockReturnValue({ user: { role: 'branch' } });

    render(<NotificationsPage />);

    expect(screen.getByText(/page 1 of 2/i)).toBeInTheDocument();
    const previousButton = screen.getByRole('button', { name: /previous/i });
    expect(previousButton).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    expect(mockUseNotifications).toHaveBeenLastCalledWith(2, 25);
  });

  it('links "Back to dashboard" and the breadcrumb to the signed-in user\'s role dashboard', () => {
    setup();
    mockUseAuth.mockReturnValue({ user: { role: 'supervisor' } });

    render(<NotificationsPage />);

    const backLink = screen.getByRole('link', { name: /back to dashboard/i });
    expect(backLink).toHaveAttribute('href', '/supervisor/dashboard');
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/supervisor/dashboard');
  });

  it('falls back to /login for the back link when there is no signed-in user', () => {
    setup();
    mockUseAuth.mockReturnValue({ user: null });

    render(<NotificationsPage />);

    expect(screen.getByRole('link', { name: /back to dashboard/i })).toHaveAttribute('href', '/login');
  });

  it('filters the list to unread notifications only via the read-status tabs', async () => {
    setup({
      items: [
        notification({ id: 'n-1', message: 'Stock is low', read: false }),
        notification({ id: 'n-2', message: 'Shift closed', read: true }),
      ],
    });

    render(<NotificationsPage />);

    expect(screen.getByText('Stock is low')).toBeInTheDocument();
    expect(screen.getByText('Shift closed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Unread' }));

    expect(screen.queryByText('Shift closed')).not.toBeInTheDocument();
    expect(screen.getByText('Stock is low')).toBeInTheDocument();
  });

  it('filters the list by search text against the notification message', async () => {
    setup({
      items: [
        notification({ id: 'n-1', message: 'Stock is low', read: false }),
        notification({ id: 'n-2', message: 'Shift closed', read: true }),
      ],
    });

    render(<NotificationsPage />);

    fireEvent.change(screen.getByPlaceholderText('Search notifications…'), { target: { value: 'shift' } });

    // SearchInput debounces onChange (default 300ms) before it reaches this
    // component's filter state.
    await waitFor(() => expect(screen.queryByText('Stock is low')).not.toBeInTheDocument());
    expect(screen.getByText('Shift closed')).toBeInTheDocument();
  });
});
