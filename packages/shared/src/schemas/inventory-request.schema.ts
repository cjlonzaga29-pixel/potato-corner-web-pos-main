import { z } from 'zod'

export const SubmitInventoryRequestSchema = z.object({
  branchId: z.string().cuid(),
  ingredientId: z.string().cuid(),
  type: z.enum(['stock_in', 'stock_out']),
  quantity: z.number().positive(),
  reason: z.string().min(3),
})

export const ApproveInventoryRequestSchema = z.object({
  requestId: z.string().cuid(),
})

export const RejectInventoryRequestSchema = z.object({
  requestId: z.string().cuid(),
  rejectionReason: z.string().min(3),
})

export const InventoryRequestResponseSchema = z.object({
  id: z.string(),
  branchId: z.string(),
  branchName: z.string(),
  ingredientId: z.string(),
  ingredientName: z.string(),
  type: z.enum(['stock_in', 'stock_out']),
  quantity: z.number(),
  reason: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  requestedById: z.string(),
  requestedByName: z.string(),
  approvedById: z.string().nullable(),
  approvedByName: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
})

export type SubmitInventoryRequestInput = z.infer<typeof SubmitInventoryRequestSchema>
export type ApproveInventoryRequestInput = z.infer<typeof ApproveInventoryRequestSchema>
export type RejectInventoryRequestInput = z.infer<typeof RejectInventoryRequestSchema>
export type InventoryRequestResponse = z.infer<typeof InventoryRequestResponseSchema>
