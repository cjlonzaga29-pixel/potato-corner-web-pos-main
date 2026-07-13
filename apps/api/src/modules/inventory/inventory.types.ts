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
