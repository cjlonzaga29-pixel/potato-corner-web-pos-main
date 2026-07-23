export interface FlavorRequestListFilters {
  status?: string;
  branch_id?: string;
  requested_by?: string;
  page: number;
  limit: number;
}

export interface CreateFlavorRequestData {
  branchId: string;
  proposedName: string;
  proposedDescription?: string;
  proposedColorHex: string;
  proposedDisplayOrder?: number;
  requestReason: string;
}

/** Mirrors ProductRequestError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class FlavorRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'FlavorRequestError';
  }
}
