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
  /** Optional — the legacy backfill omits this (its quantities are always already in the item's base unit); the API service always resolves and passes one. */
  recipeUnitId?: string;
  /** Set by the legacy backfill to mark rows it created, so a re-run can tell them apart from manually created rows. Omitted (null) for API-created rows. */
  createdBy?: string;
  /** null/omitted = Base Recipe component; a ProductOption id = option-scoped component. */
  productOptionId?: string | null;
}

export interface UpdateProductComponentData {
  quantityRequired?: number;
  recipeUnitId?: string;
  isActive?: boolean;
  /** undefined = leave unchanged; null = clear back to Base Recipe. */
  productOptionId?: string | null;
}
