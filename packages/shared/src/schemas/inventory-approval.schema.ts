import { z } from 'zod';

// ---------------------------------------------------------------------------
// POS-PERF-P28 — Supervisor approval for manual inventory changes.
// Submission inputs deliberately reuse the existing receive/adjust/count
// (universal) and stock-in/adjust/count (legacy) input schemas unchanged —
// the request body shape for those routes does not change, only what the
// handler does with it (creates a pending request instead of writing stock).
// This file only adds the review-workflow's own request/response shapes.
// ---------------------------------------------------------------------------

export const inventoryApprovalOperationSchema = z.enum(['RECEIVING', 'ADJUSTMENT', 'PHYSICAL_COUNT', 'WASTE']);
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

/**
 * POS-PERF-P29R3 — administrative-acknowledgment-only path for a PENDING
 * request that predates the mandatory staff-PIN-verification/evidence
 * policy (RECEIVING/ADJUSTMENT/WASTE submitted before
 * responsible_staff_user_id/proof_key existed, or before they were
 * required). This does NOT approve the request and does NOT apply stock —
 * normal approve() still refuses it outright (LEGACY_VERIFICATION_MISSING).
 * The mandatory reason is only the reviewer's written note for the audit
 * log; it is never accepted as a substitute for an actual PIN verification/
 * evidence pair. The only ways to actually resolve the request are a
 * correction carrying a fresh verification_token/evidence_key, or permanent
 * cancellation.
 */
export const legacyReconcileInventoryApprovalRequestSchema = z.object({
  reason: z.string().min(1, 'A reconciliation justification is required').max(1000),
});

/**
 * Correcting a RETURNED request resubmits the same operation-specific
 * fields that created it, plus the revision it corrects (server re-derives
 * revisionNumber; this is only an optimistic-concurrency guard against
 * correcting an already-superseded revision).
 *
 * POS-PERF-P29R2 — verification_token/evidence_key are optional here at the
 * schema level (unlike receiveInventoryStockSchema/adjustInventoryStockSchema/
 * wasteInventoryStockSchema, where they are always mandatory) because
 * PHYSICAL_COUNT corrections never require them; the service enforces them
 * as mandatory for RECEIVING/ADJUSTMENT/WASTE corrections specifically
 * (operationRequiresStaffVerification in inventory-approval.service.ts) —
 * a correction changes the entered quantity/reason, so it is treated as a
 * fresh operation requiring its own fresh PIN verification and proof, not
 * one inherited from the original (now-returned) submission.
 */
export const correctInventoryApprovalRequestSchema = z.object({
  entered_quantity: z.number().positive().optional(),
  entered_unit_id: z.uuid().optional(),
  total_cost: z.number().positive().optional(),
  delivery_reference: z.string().max(100).optional(),
  quantity_delta: z.number().refine((n) => n === undefined || n !== 0, 'quantity_delta must not be zero').optional(),
  counted_quantity: z.number().nonnegative().optional(),
  reason_code: z.string().min(1).optional(),
  notes: z.string().optional(),
  verification_token: z.string().min(1).optional(),
  evidence_key: z.uuid().optional(),
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

  // POS-PERF-P29 — responsible staff resolved from the StaffPinVerification
  // token at submit time, denormalized for stable display.
  responsible_staff_user_id: z.uuid().nullable(),
  responsible_staff_name: z.string().nullable(),
  pin_verified_at: z.iso.datetime().nullable(),

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
