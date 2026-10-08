import { z } from 'zod';

// ---------------------------------------------------------------------------
// POS-PERF-P28 — Supervisor approval for manual inventory changes.
// Submission inputs deliberately reuse the existing receive/adjust/count
// (universal) and stock-in/adjust/count (legacy) input schemas unchanged —
// the request body shape for those routes does not change, only what the
// handler does with it (creates a pending request instead of writing stock).
// This file only adds the review-workflow's own request/response shapes.
// ---------------------------------------------------------------------------

export const inventoryApprovalOperationSchema = z.enum(['RECEIVING', 'ADJUSTMENT', 'PHYSICAL_COUNT']);
// POS-PERF-P28R2: CANCELLED is a permanent terminal state for a request
// retired during rollback/reconciliation — see cancelInventoryApprovalRequestSchema.
export const inventoryApprovalStatusSchema = z.enum(['PENDING', 'APPROVED', 'RETURNED', 'CANCELLED']);
export const inventoryApprovalTargetSchema = z.enum(['UNIVERSAL_ITEM', 'LEGACY_INGREDIENT']);

export const returnInventoryApprovalRequestSchema = z.object({
  reason: z.string().min(1, 'A return reason is required').max(1000),
});

/** Permanent cancellation — a reason is mandatory, same as return-for-correction. */
export const cancelInventoryApprovalRequestSchema = z.object({
  reason: z.string().min(1, 'A cancellation reason is required').max(1000),
});

/** Correcting a RETURNED request resubmits the same operation-specific fields that created it, plus the revision it corrects (server re-derives revisionNumber; this is only an optimistic-concurrency guard against correcting an already-superseded revision). */
export const correctInventoryApprovalRequestSchema = z.object({
  entered_quantity: z.number().positive().optional(),
  entered_unit_id: z.uuid().optional(),
  total_cost: z.number().positive().optional(),
  delivery_reference: z.string().max(100).optional(),
  quantity_delta: z.number().refine((n) => n === undefined || n !== 0, 'quantity_delta must not be zero').optional(),
  counted_quantity: z.number().nonnegative().optional(),
  reason_code: z.string().min(1).optional(),
  notes: z.string().optional(),
});

export const inventoryApprovalRequestResponseSchema = z.object({
  id: z.uuid(),
  root_request_id: z.uuid(),
  previous_request_id: z.uuid().nullable(),
  revision_number: z.number(),
  batch_id: z.string().nullable(),

  target: inventoryApprovalTargetSchema,
  branch_id: z.uuid(),
  branch_name: z.string().nullable(),
  inventory_item_id: z.uuid().nullable(),
  legacy_ingredient_id: z.uuid().nullable(),
  item_name: z.string().nullable(),
  item_unit_code: z.string().nullable(),
  operation: inventoryApprovalOperationSchema,

  entered_quantity: z.number().nullable(),
  entered_unit_id: z.uuid().nullable(),
  total_cost: z.number().nullable(),
  delivery_reference: z.string().nullable(),
  quantity_delta: z.number().nullable(),
  counted_quantity: z.number().nullable(),
  quantity_on_hand_at_submission: z.number().nullable(),

  reason_code: z.string().nullable(),
  notes: z.string().nullable(),
  proof_url: z.string().nullable(),

  status: inventoryApprovalStatusSchema,
  submitted_by_user_id: z.uuid(),
  submitted_by_name: z.string().nullable(),
  submitted_at: z.iso.datetime(),
  reviewed_by_user_id: z.uuid().nullable(),
  reviewed_by_name: z.string().nullable(),
  reviewed_at: z.iso.datetime().nullable(),
  return_reason: z.string().nullable(),
  applied_movement_id: z.string().nullable(),

  cancelled_by_user_id: z.uuid().nullable(),
  cancelled_by_name: z.string().nullable(),
  cancelled_at: z.iso.datetime().nullable(),
  cancel_reason: z.string().nullable(),
});

export const inventoryApprovalRequestListResponseSchema = z.object({
  requests: z.array(inventoryApprovalRequestResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

export const inventoryApprovalRequestDetailResponseSchema = inventoryApprovalRequestResponseSchema.extend({
  revisions: z.array(inventoryApprovalRequestResponseSchema),
});
