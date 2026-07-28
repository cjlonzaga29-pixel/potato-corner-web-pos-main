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
  flavorId?: string | null;
  quantityRequired: number;
  unit: string;
}

export interface UpdateProductInventoryData {
  quantityRequired?: number;
  unit?: string;
  isActive?: boolean;
}

export interface DeductionLine {
  ingredient_id: string;
  ingredient_name: string;
  quantity: number;
  unit: string;
  source: 'master_base' | 'master_flavor' | 'branch_base' | 'branch_flavor';
}
