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

/** Repository-level shape (camelCase, Prisma field names) — used by both the service and the legacy backfill. */
export interface CreateProductComponentData {
  productVariantId: string;
  inventoryItemId: string;
  quantityRequired: number;
  /** Set by the legacy backfill to mark rows it created, so a re-run can tell them apart from manually created rows. Omitted (null) for API-created rows. */
  createdBy?: string;
}

export interface UpdateProductComponentData {
  quantityRequired?: number;
}
