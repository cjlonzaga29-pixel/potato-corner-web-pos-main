import { z } from 'zod';
import { inventoryApprovalOperationSchema } from './inventory-approval.schema.js';

// ---------------------------------------------------------------------------
// POS-PERF-P29 — staff PIN identification for manual inventory operations.
// Separate from the PinCredential login shortcut: this never issues or
// elevates a session, it only identifies which staff member physically
// performed an operation an already-authenticated session is submitting.
// ---------------------------------------------------------------------------

const pinFormatSchema = z
  .string()
  .regex(/^\d{4,6}$/, 'PIN must be 4-6 digits');

export const setStaffPinSchema = z.object({
  pin: pinFormatSchema,
});

export const verifyStaffPinSchema = z.object({
  pin: pinFormatSchema,
  operation: inventoryApprovalOperationSchema,
  inventory_item_id: z.uuid().optional(),
  // Canonical draft fields the resulting token is bound to — re-hashed and
  // compared at submit time, so a changed quantity/unit/reason/notes after
  // verification invalidates the token rather than silently carrying over.
  quantity: z.number().optional(),
  unit_id: z.uuid().optional(),
  reason_code: z.string().optional(),
  notes: z.string().optional(),
});

export const staffPinVerifyResponseSchema = z.object({
  staff_name: z.string(),
  verification_token: z.string(),
  expires_at: z.iso.datetime(),
});

export const staffPinStatusResponseSchema = z.object({
  user_id: z.uuid(),
  has_pin: z.boolean(),
  is_active: z.boolean(),
  set_at: z.iso.datetime().nullable(),
});
