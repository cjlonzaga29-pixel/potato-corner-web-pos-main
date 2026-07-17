import { notificationsRepository } from './notifications.repository.js';
import { NotificationError, type NotificationPagination } from './notifications.types.js';

interface NotificationRow {
  id: string;
  type: string;
  payload: unknown;
  branchId: string;
  readAt: Date | null;
  createdAt: Date;
}

function toNotificationResponse(row: NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    branch_id: row.branchId,
    read: row.readAt !== null,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * Notifications business logic. Called by the router after Zod validation;
 * never calls Prisma directly — always goes through notificationsRepository.
 * Every method is scoped to the requesting user's own recipientUserId — this
 * module has no admin-only view of another user's notifications.
 */
export const notificationsService = {
  async listForRecipient(userId: string, pagination: NotificationPagination) {
    const { notifications, total, unreadCount } = await notificationsRepository.findForRecipient(userId, pagination);
    return {
      notifications: (notifications as NotificationRow[]).map(toNotificationResponse),
      total,
      unread_count: unreadCount,
      page: pagination.page,
      limit: pagination.limit,
    };
  },

  async markRead(id: string, userId: string): Promise<void> {
    const result = await notificationsRepository.markRead(id, userId);
    if (result.count === 0) {
      throw new NotificationError('NOTIFICATION_NOT_FOUND', 'Notification not found', 404);
    }
  },

  async markAllRead(userId: string): Promise<{ updated_count: number }> {
    const result = await notificationsRepository.markAllRead(userId);
    return { updated_count: result.count };
  },
};
