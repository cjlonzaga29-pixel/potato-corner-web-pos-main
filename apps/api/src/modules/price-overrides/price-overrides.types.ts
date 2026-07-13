export interface PriceOverrideListFilters {
  status?: string;
  branch_id?: string;
  page: number;
  limit: number;
}

export interface CreatePriceOverrideData {
  branchId: string;
  productVariantId: string;
  requestedPrice: number;
  requestReason: string;
}

/** Mirrors ProductError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class PriceOverrideError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PriceOverrideError';
  }
}
