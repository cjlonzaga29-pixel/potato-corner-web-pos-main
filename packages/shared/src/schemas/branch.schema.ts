import { z } from 'zod';
import { BRANCH_STATUS, type BranchStatus } from '../constants/status.js';

const branchStatusValues = Object.values(BRANCH_STATUS) as [BranchStatus, ...BranchStatus[]];

const paymentBreakdownEntrySchema = z.object({
  total: z.number(),
  count: z.number().int(),
});

export const paymentBreakdownSchema = z.object({
  cash: paymentBreakdownEntrySchema,
  gcash: paymentBreakdownEntrySchema,
  maya: paymentBreakdownEntrySchema,
  other: paymentBreakdownEntrySchema,
});

/** PC-[CITY_SHORT]-[NUMBER] — CITY_SHORT is 2-5 uppercase letters, NUMBER is zero-padded to 3 digits. */
export const branchCodeSchema = z
  .string()
  .regex(/^PC-[A-Z]{2,5}-[0-9]{3}$/, 'Branch code must match PC-[CITY]-[NUM], e.g. PC-MNL-001');

/**
 * Task 174 — Branch Employee Authorization: creating a branch's login
 * account is optional at the schema layer (existing branches created before
 * this fix, and any future branch-then-assign-supervisor-only flow, have no
 * account), but when provided, branchesService.createBranch creates the
 * branch row and this account in the SAME database transaction — no more
 * two-step create-branch-then-create-account flow that can leave an orphan
 * branch with no login if the second call fails.
 */
export const createBranchAccountSchema = z.object({
  email: z.email('Must be a valid email'),
  password: z.string().min(8, 'Minimum 8 characters'),
});

export const createBranchSchema = z.object({
  name: z.string().min(2).max(100),
  // Omitted entirely -> auto-generated (branches.service.ts). Provided -> validated against branchCodeSchema and uniqueness.
  code: branchCodeSchema.optional(),
  address: z.string().min(5),
  city: z.string().min(2),
  gpsLatitude: z.number().min(-90).max(90).optional(),
  gpsLongitude: z.number().min(-180).max(180).optional(),
  gpsRadiusMeters: z.number().int().min(10).max(1000).default(100),
  status: z.enum(branchStatusValues).default('active'),
  account: createBranchAccountSchema.optional(),
});

/** Code is deliberately absent — branch codes are immutable after creation (locked rule). */
export const updateBranchSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  address: z.string().min(5).optional(),
  city: z.string().min(2).optional(),
  gpsLatitude: z.number().min(-90).max(90).optional(),
  gpsLongitude: z.number().min(-180).max(180).optional(),
  gpsRadiusMeters: z.number().int().min(10).max(1000).optional(),
  status: z.enum(branchStatusValues).optional(),
  gcashQrUrl: z.string().nullable().optional(),
  gcashQrKey: z.string().nullable().optional(),
});

export const changeBranchStatusSchema = z.object({
  status: z.enum(branchStatusValues),
});

/**
 * POS-PERF-P67 — DELETE /api/branches/:id body. confirm_name and
 * confirm_code are what the Super Admin typed (the name ignoring case and
 * extra spaces, the code exactly). version and confirmation_token come from
 * GET /api/branches/:id/deletion-eligibility: the token is issued by the
 * server for this actor, this branch and this version, so a confirmation
 * reviewed by someone else, for another branch or before an edit is refused.
 */
export const deleteBranchSchema = z.object({
  confirm_name: z.string().trim().min(1).max(200),
  confirm_code: z.string().trim().min(1).max(20),
  version: z.iso.datetime({ offset: true }),
  confirmation_token: z.string().regex(/^[0-9a-f]{64}$/),
});

export const branchDeletionBlockerCodeValues = [
  'open_shifts',
  'open_attendance',
  'pending_checkouts',
  'held_orders',
  'pending_inventory_jobs',
  'nonzero_stock',
  'draft_payroll_runs',
  'unpaid_payroll_hours',
] as const;

export const branchDeletionBlockerSchema = z.object({
  code: z.enum(branchDeletionBlockerCodeValues),
  count: z.number().int(),
  message: z.string(),
});

export const branchDeletionEligibilitySchema = z.object({
  branch_id: z.uuid(),
  can_delete: z.boolean(),
  blocked_reason: z.enum(['open_operations', 'already_deleted']).nullable(),
  blockers: z.array(branchDeletionBlockerSchema),
  /** Counts of history that stays (attributed to the branch's historical record). */
  history_retained: z.record(z.string(), z.number().int()).nullable(),
  /** What goes with the branch: accounts, access, configuration. */
  removed: z.record(z.string(), z.number().int()).nullable(),
  confirmation: z
    .object({ name: z.string(), code: z.string(), version: z.iso.datetime(), confirmation_token: z.string() })
    .nullable(),
});

export const branchDeletionResultSchema = z.object({
  deleted: z.literal(true),
  outcome: z.enum(['deleted', 'already_deleted']),
});

export const branchResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
  address: z.string(),
  city: z.string(),
  gpsLatitude: z.number().nullable(),
  gpsLongitude: z.number().nullable(),
  gpsRadiusMeters: z.number(),
  status: z.enum(branchStatusValues),
  gcashQrUrl: z.string().nullable(),
  gcashQrKey: z.string().nullable(),
  activeSupervisorCount: z.number().int(),
  activeStaffCount: z.number().int(),
  currentStatusLabel: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const branchListResponseSchema = z.object({
  branches: z.array(branchResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

export const assignSupervisorSchema = z.object({
  userId: z.uuid(),
});

export const branchAssignmentResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  branchId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.email(),
  role: z.string(),
  assignedAt: z.iso.datetime(),
});

export const branchStatsResponseSchema = z.object({
  activeShiftsCount: z.number().int(),
  todayTransactionCount: z.number().int(),
  todayGrossSales: z.number(),
  todayDiscountTotal: z.number(),
  todayRefundTotal: z.number(),
  todayNetSales: z.number(),
  /** VAT of today's VAT-calculated sales only — never complete coverage when todayTaxNotCalculatedCount > 0. */
  todayVat: z.number(),
  /**
   * POS-PERF-P55R3 — today's completed manual-total sales (VAT not
   * calculated) and their amount paid: excluded from todayVat, included in
   * gross/net sales. Optional only because an older API omits them.
   */
  todayTaxNotCalculatedCount: z.number().int().optional(),
  todayTaxNotCalculatedSales: z.number().optional(),
  todayExpenses: z.number(),
  // Canonical P2 formula: todayNetSales - todayExpenses. No COGS/waste
  // dependency — see lib/financial-metrics.ts's computeFinancialMetrics.
  todayNetOperatingResult: z.number(),
  paymentBreakdown: paymentBreakdownSchema,
  activeStaffCount: z.number().int(),
  staffTimedInCount: z.number().int(),
  lowStockIngredientCount: z.number().int(),
});

// ---------------------------------------------------------------------------
// POS-PERF-P68 — Force Delete Branch (Super Admin only)
// ---------------------------------------------------------------------------

export const forceDeletionItemKindValues = [
  'open_shift',
  'open_attendance',
  'pending_checkout',
  'held_order',
  'deduction_job',
  'projection_outbox',
  'inventory_approval',
  'stock_balance',
  'draft_payroll_run',
  'unpaid_payroll_hours',
] as const;

export const forceDeletionPlanGroupSchema = z.object({
  kind: z.enum(forceDeletionItemKindValues),
  count: z.number().int(),
  outcome: z.string(),
  /** What happens to these items, in plain words. */
  explanation: z.string(),
  /** Up to 20 short descriptions (ids, names, quantities) for the dialog. */
  examples: z.array(z.string()),
});

export const forceDeletionPlanSchema = z.object({
  branch_id: z.uuid(),
  in_progress_operation_id: z.string().nullable(),
  groups: z.array(forceDeletionPlanGroupSchema),
  history_retained: z.record(z.string(), z.number()),
  removed: z.record(z.string(), z.number()),
  /** Stated plainly in the dialog: the server cannot reach offline terminals. */
  offline_notice: z.string(),
  confirmation: z.object({
    name: z.string(),
    code: z.string(),
    version: z.string(),
    plan_keys: z.array(z.string()),
    plan_hash: z.string(),
    confirmation_token: z.string(),
  }),
});

export const forceDeleteBranchSchema = z.object({
  /** Client-generated once per confirmation; a repeat with it returns the same operation. */
  operation_id: z.uuid(),
  confirm_name: z.string().trim().min(1).max(200),
  confirm_code: z.string().trim().min(1).max(20),
  version: z.iso.datetime({ offset: true }),
  plan_keys: z.array(z.string().max(300)).max(20_000),
  plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
  confirmation_token: z.string().regex(/^[0-9a-f]{64}$/),
  acknowledge: z.literal(true),
});

export const forceDeletionStatusValues = [
  'fenced',
  'completed',
  'aborted',
  'failed',
  'already_deleted',
] as const;

export const forceDeletionStatusSchema = z.object({
  operation_id: z.string().nullable(),
  branch_id: z.string(),
  status: z.enum(forceDeletionStatusValues),
  step: z.string().nullable(),
  abort_reason: z.string().nullable(),
  last_error: z.string().nullable(),
  closure_item_count: z.number().int(),
  created_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

export const branchClosureItemSchema = z.object({
  id: z.string(),
  operation_id: z.string(),
  branch_id: z.string(),
  branch_name: z.string(),
  branch_code: z.string(),
  kind: z.string(),
  source_table: z.string(),
  source_id: z.string(),
  outcome: z.string(),
  reason: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
  recorded_by_name: z.string(),
  recorded_at: z.string(),
  reconciled_at: z.string().nullable(),
  reconciled_by_name: z.string().nullable(),
  reconciliation_note: z.string().nullable(),
});

export const branchClosureItemListSchema = z.object({
  items: z.array(branchClosureItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

export const reconcileClosureItemSchema = z.object({
  note: z.string().trim().min(5, 'Say how it was settled (at least 5 characters)').max(1000),
});
