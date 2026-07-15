export interface ProductRequestListFilters {
  status?: string;
  branch_id?: string;
  requested_by?: string;
  page: number;
  limit: number;
}

export interface CreateProductRequestData {
  branchId: string;
  proposedName: string;
  proposedDescription?: string;
  proposedCategory?: string;
  proposedVariants: unknown;
  proposedFlavors: unknown;
  proposedRecipes: unknown;
  requestReason: string;
}

/** Mirrors ProductError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class ProductRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProductRequestError';
  }
}
