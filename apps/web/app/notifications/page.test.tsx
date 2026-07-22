import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import NotificationsPage from './page';
import type { NotificationItem } from '@/components/shared/notification-bell';

const { mockUseNotifications, mockUseMarkNotificationRead, mockUseMarkAllNotificationsRead, mockMarkAllMutate } =
  vi.hoisted(() => ({
    mockUseNotifications: vi.fn(),
    mockUseMarkNotificationRead: vi.fn(),
    mockUseMarkAllNotificationsRead: vi.fn(),
    mockMarkAllMutate: vi.fn(),
  }));

vi.mock('@/hooks/queries/use-notifications', () => ({
  useNotifications: mockUseNotifications,
  useMarkNotificationRead: mockUseMarkNotificationRead,
  useMarkAllNotificationsRead: mockUseMarkAllNotificationsRead,
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
  data?: NotificationItem[];
  isLoading?: boolean;
  isError?: boolean;
}

function setup(overrides: NotificationsQueryOverrides = {}) {
  mockUseNotifications.mockReturnValue({
    data: [notification()],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...overrides,
  });
  mockUseMarkNotificationRead.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseMarkAllNotificationsRead.mockReturnValue({ mutate: mockMarkAllMutate, isPending: false });
}

describe('NotificationsPage', () => {
  it('renders a loading skeleton while notifications are loading', () => {
    setup({ data: undefined, isLoading: true });

    const { container } = render(<NotificationsPage />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders the empty state when there are no notifications', () => {
    setup({ data: [] });

    render(<NotificationsPage />);

    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });

  it('renders the notification list when notifications are present', () => {
    setup({ data: [notification({ message: 'An ingredient is running low on stock.' })] });

    render(<NotificationsPage />);

    expect(screen.getByText('An ingredient is running low on stock.')).toBeInTheDocument();
  });

  it('disables "Mark all as read" when there are 0 unread notifications', () => {
    setup({ data: [notification({ read: true })] });

    render(<NotificationsPage />);

    expect(screen.getByRole('button', { name: /Mark all as read/ })).toBeDisabled();
  });

  it('enables "Mark all as read" and triggers the mutation when there are unread notifications', () => {
    setup({ data: [notification({ read: false })] });

    render(<NotificationsPage />);

    const button = screen.getByRole('button', { name: /Mark all as read/ });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(mockMarkAllMutate).toHaveBeenCalledTimes(1);
  });
});
