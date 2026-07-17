import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./notifications.repository.js', () => ({
  notificationsRepository: {
    findForRecipient: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  },
}));

const { notificationsRepository } = await import('./notifications.repository.js');
const { notificationsService } = await import('./notifications.service.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notificationsService.listForRecipient', () => {
  it('maps rows to the snake_case response shape and passes through pagination/counts', async () => {
    const createdAt = new Date('2026-07-17T10:00:00.000Z');
    vi.mocked(notificationsRepository.findForRecipient).mockResolvedValue({
      notifications: [
        { id: 'notif-1', type: 'low_stock', payload: { type: 'low_stock' }, branchId: 'branch-1', readAt: null, createdAt },
        {
          id: 'notif-2',
          type: 'eod_summary',
          payload: { type: 'eod_summary' },
          branchId: 'branch-1',
          readAt: new Date('2026-07-17T11:00:00.000Z'),
          createdAt,
        },
      ],
      total: 2,
      unreadCount: 1,
    } as never);

    const result = await notificationsService.listForRecipient('user-1', { page: 1, limit: 25 });

    expect(notificationsRepository.findForRecipient).toHaveBeenCalledWith('user-1', { page: 1, limit: 25 });
    expect(result).toEqual({
      notifications: [
        { id: 'notif-1', type: 'low_stock', payload: { type: 'low_stock' }, branch_id: 'branch-1', read: false, created_at: createdAt.toISOString() },
        {
          id: 'notif-2',
          type: 'eod_summary',
          payload: { type: 'eod_summary' },
          branch_id: 'branch-1',
          read: true,
          created_at: createdAt.toISOString(),
        },
      ],
      total: 2,
      unread_count: 1,
      page: 1,
      limit: 25,
    });
  });
});

describe('notificationsService.markRead', () => {
  it('resolves when the notification belongs to the given recipient', async () => {
    vi.mocked(notificationsRepository.markRead).mockResolvedValue({ count: 1 });

    await expect(notificationsService.markRead('notif-1', 'user-1')).resolves.toBeUndefined();
    expect(notificationsRepository.markRead).toHaveBeenCalledWith('notif-1', 'user-1');
  });

  it('throws NOTIFICATION_NOT_FOUND (404) when the notification is missing or belongs to a different recipient', async () => {
    vi.mocked(notificationsRepository.markRead).mockResolvedValue({ count: 0 });

    await expect(notificationsService.markRead('notif-1', 'other-user')).rejects.toMatchObject({
      code: 'NOTIFICATION_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('notificationsService.markAllRead', () => {
  it('returns the updated count', async () => {
    vi.mocked(notificationsRepository.markAllRead).mockResolvedValue({ count: 3 });

    const result = await notificationsService.markAllRead('user-1');

    expect(notificationsRepository.markAllRead).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({ updated_count: 3 });
  });
});
