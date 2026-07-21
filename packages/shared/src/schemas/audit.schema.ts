import { z } from 'zod';

/**
 * GET /api/audit query filters — same page/limit pagination shape as every
 * other list endpoint. date_from/date_to are date-only (YYYY-MM-DD), widened
 * to a full-day range server-side, matching transaction.schema.ts.
 */
export const auditLogListQuerySchema = z.object({
  action: z.string().optional(),
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  actor_id: z.uuid().optional(),
  branch_id: z.uuid().optional(),
  date_from: z.iso.date().optional(),
  date_to: z.iso.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

/** Mirrors the audit_logs table (see prisma/schema.prisma) field for field — this is a read-only log, so the response is a direct projection. */
export const auditLogResponseSchema = z.object({
  id: z.uuid(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string().nullable(),
  actor_id: z.uuid().nullable(),
  actor_role: z.string(),
  actor: z
    .object({
      id: z.uuid(),
      first_name: z.string(),
      last_name: z.string(),
      email: z.string(),
    })
    .nullable(),
  branch_id: z.uuid().nullable(),
  branch: z
    .object({
      id: z.uuid(),
      name: z.string(),
    })
    .nullable(),
  before_state: z.unknown().nullable(),
  after_state: z.unknown().nullable(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  previous_hash: z.string(),
  current_hash: z.string(),
  created_at: z.iso.datetime(),
});

export const auditLogListResponseSchema = z.object({
  logs: z.array(auditLogResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
