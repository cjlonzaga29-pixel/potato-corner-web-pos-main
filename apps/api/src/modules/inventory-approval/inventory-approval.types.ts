import type { ImageProofType } from '@potato-corner/shared';

/** Mirrors UniversalInventoryError/IngredientError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class InventoryApprovalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'InventoryApprovalError';
  }
}

export type InventoryApprovalTarget = 'UNIVERSAL_ITEM' | 'LEGACY_INGREDIENT';
export type InventoryApprovalOperation = 'RECEIVING' | 'ADJUSTMENT' | 'PHYSICAL_COUNT';
export type InventoryApprovalStatus = 'PENDING' | 'APPROVED' | 'RETURNED';

export interface SubmitReceivingData {
  target: InventoryApprovalTarget;
  branchId: string;
  inventoryItemId?: string;
  legacyIngredientId?: string;
  enteredQuantity: number;
  enteredUnitId?: string;
  totalCost?: number;
  deliveryReference?: string;
  notes?: string;
}

export interface SubmitAdjustmentData {
  target: InventoryApprovalTarget;
  branchId: string;
  inventoryItemId?: string;
  legacyIngredientId?: string;
  quantityDelta: number;
  reasonCode: string;
  notes?: string;
}

export interface SubmitPhysicalCountData {
  target: InventoryApprovalTarget;
  branchId: string;
  counts: { inventoryItemId?: string; legacyIngredientId?: string; countedQuantity: number }[];
  notes?: string;
}

export interface CorrectRequestData {
  enteredQuantity?: number;
  enteredUnitId?: string;
  totalCost?: number;
  deliveryReference?: string;
  quantityDelta?: number;
  countedQuantity?: number;
  reasonCode?: string;
  notes?: string;
}

export interface ListApprovalFilters {
  branchId?: string;
  status?: InventoryApprovalStatus;
  submittedByUserId?: string;
  page: number;
  limit: number;
}

export type { ImageProofType };
