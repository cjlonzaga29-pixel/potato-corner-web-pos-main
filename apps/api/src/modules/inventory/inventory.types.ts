import type { MovementType, ImageProofType } from '@potato-corner/shared';

/** Mirrors ProductError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class IngredientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'IngredientError';
  }
}

export interface CreateIngredientData {
  branchId: string;
  name: string;
  unit: string;
  currentStock: number;
  lowStockThreshold: number;
  criticalThreshold: number;
  unitCost?: number;
}

export interface UpdateIngredientData {
  name?: string;
  unit?: string;
  lowStockThreshold?: number;
  criticalThreshold?: number;
  unitCost?: number;
}

/** Every stock-affecting write funnels through this one shape before hitting the append-only ledger. */
export interface AppendMovementInput {
  branchId: string;
  ingredientId: string;
  movementType: MovementType;
  quantityChange: number;
  referenceId?: string;
  notes?: string;
  imageProofUrl?: string;
  imageProofType?: ImageProofType;
  approvedBy?: string;
  recordedBy?: string;
}

export interface MovementListFilters {
  ingredientId?: string;
  movementType?: MovementType;
  fromDate?: Date;
  toDate?: Date;
  page: number;
  limit: number;
}
