import { z } from 'zod';

/** GET /api/notifications query filters — same page/limit pagination shape as every other list endpoint. */
export const notificationListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export const notificationResponseSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  payload: z.unknown(),
  branch_id: z.uuid(),
  read: z.boolean(),
  created_at: z.iso.datetime(),
});

export const notificationListResponseSchema = z.object({
  notifications: z.array(notificationResponseSchema),
  total: z.number().int(),
  unread_count: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
