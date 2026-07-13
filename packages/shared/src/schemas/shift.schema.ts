import { z } from 'zod';

/** Philippine peso denominations, per the architecture spec. */
export const PESO_DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01] as const;

export const denominationCountSchema = z.object({
  denomination: z.number().refine((value) => (PESO_DENOMINATIONS as readonly number[]).includes(value), {
    message: 'Not a recognized Philippine peso denomination',
  }),
  count: z.number().int().nonnegative(),
});

export const openShiftSchema = z.object({
  branchId: z.uuid(),
  cashierId: z.uuid(),
  openingDenominations: z.array(denominationCountSchema).min(1),
});

export const closeShiftSchema = z.object({
  shiftId: z.uuid(),
  closingDenominations: z.array(denominationCountSchema).min(1),
  // Required only when the calculated variance exceeds the configured tolerance.
  varianceExplanation: z.string().min(50).optional(),
});

export const approveVarianceSchema = z.object({
  shiftId: z.uuid(),
  approvalReason: z.string().min(50),
});

export const shiftResponseSchema = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  cashierId: z.uuid(),
  status: z.enum(['active', 'closed', 'flagged']),
  openingCashAmount: z.number(),
  closingCashAmount: z.number().nullable(),
  expectedClosingCash: z.number().nullable(),
  cashVariance: z.number().nullable(),
  cashSalesTotal: z.number(),
  gcashSalesTotal: z.number(),
  transactionCount: z.number().int(),
  startedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
});
