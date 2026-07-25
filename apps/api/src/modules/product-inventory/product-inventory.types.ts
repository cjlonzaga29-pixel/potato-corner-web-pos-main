/** Mirrors RecipeError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class ProductInventoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProductInventoryError';
  }
}

export interface CreateProductInventoryData {
  productVariantId: string;
  ingredientId: string;
  quantityRequired: number;
  unit: string;
}

export interface UpdateProductInventoryData {
  quantityRequired?: number;
  unit?: string;
}
