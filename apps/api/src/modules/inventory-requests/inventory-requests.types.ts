import type { Prisma } from '@prisma/client';

export type InventoryRequestKind = 'stock_in' | 'stock_out';

/** Mirrors ProductRequestError/IngredientError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class InventoryRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'InventoryRequestError';
  }
}

export interface CreateInventoryRequestData {
  branchId: string;
  ingredientId: string;
  type: InventoryRequestKind;
  quantity: number;
  reason: string;
  requestedById: string;
  requestedByName: string;
}

/**
 * The status flip and its stock effect happen together, so approve() takes
 * every field the movement insert needs, already resolved by the service —
 * no re-fetch of the request row happens inside the transaction.
 */
export interface ApproveInventoryRequestData {
  branchId: string;
  ingredientId: string;
  type: InventoryRequestKind;
  quantity: Prisma.Decimal;
  reason: string;
  requestedById: string;
  approvedById: string;
  approvedByName: string;
}

export interface RejectInventoryRequestData {
  approvedById: string;
  approvedByName: string;
  rejectionReason: string;
}
