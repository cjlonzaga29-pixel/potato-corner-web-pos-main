import { z } from 'zod';

/** Philippine peso denominations, per the architecture spec. */
export const PESO_DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01] as const;

export const denominationCountSchema = z.object({
  denomination: z.number().refine((value) => (PESO_DENOMINATIONS as readonly number[]).includes(value), {
    message: 'Not a recognized Philippine peso denomination',
  }),
  quantity: z.number().int().nonnegative(),
});

export const openShiftSchema = z.object({
  branch_id: z.uuid(),
  // The staff member the register is being opened for. May equal the
  // opener's own id, or — per the architecture doc's "supervisor opens on
  // behalf of staff" allowance — a different staff member's id, in which
  // case the opener (req.user) is still the one who personally counted
  // the cash and is recorded as such via opened_by.
  cashier_id: z.uuid(),
  // Cross-checked server-side against the sum of `denominations` — catches
  // a client-side running-total bug before it becomes a bad opening balance.
  starting_cash: z.number().positive(),
  denominations: z.array(denominationCountSchema).min(1),
});

export const closeShiftSchema = z.object({
  denominations: z.array(denominationCountSchema).min(1),
  notes: z.string().optional(),
  // Required only when the calculated variance is outside tolerance —
  // enforced in cash.service.ts once the variance is known, since Zod
  // can't see the computed variance at parse time.
  variance_explanation: z.string().min(50).optional(),
});

export const approveVarianceSchema = z.object({
  approved: z.boolean(),
  // Required for both approval and rejection — a written justification,
  // never a one-word rubber stamp (architecture doc §9).
  notes: z.string().min(50),
});

export const voidShiftSchema = z.object({
  reason: z.string().optional(),
});

export const shiftDenominationResponseSchema = z.object({
  id: z.uuid(),
  denomination: z.number(),
  quantity: z.number().int(),
  subtotal: z.number(),
  phase: z.enum(['opening', 'closing']),
});

export const shiftResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  cashier_id: z.uuid(),
  opened_by: z.uuid(),
  closed_by: z.uuid().nullable(),
  status: z.enum(['active', 'closed', 'flagged']),
  opening_cash_amount: z.number(),
  closing_cash_amount: z.number().nullable(),
  expected_closing_cash: z.number().nullable(),
  cash_variance: z.number().nullable(),
  variance_approved: z.boolean().nullable(),
  variance_explanation: z.string().nullable(),
  variance_approved_by: z.uuid().nullable(),
  variance_approval_reason: z.string().nullable(),
  cash_sales_total: z.number(),
  gcash_sales_total: z.number(),
  transaction_count: z.number().int(),
  shift_notes: z.string().nullable(),
  started_at: z.iso.datetime(),
  closed_at: z.iso.datetime().nullable(),
  denominations: z.array(shiftDenominationResponseSchema).optional(),
});

export const shiftListResponseSchema = z.object({
  shifts: z.array(shiftResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
