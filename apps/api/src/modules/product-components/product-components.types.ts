/** Mirrors ProductInventoryError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class ProductComponentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProductComponentError';
  }
}

export interface CreateProductComponentData {
  productVariantId: string;
  inventoryItemId: string;
  quantityRequired: number;
}

export interface UpdateProductComponentData {
  quantityRequired?: number;
}
