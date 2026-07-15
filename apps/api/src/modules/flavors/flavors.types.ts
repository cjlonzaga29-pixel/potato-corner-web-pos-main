export interface FlavorListFilters {
  is_active?: boolean;
  search?: string;
  page: number;
  limit: number;
  sort_by?: 'name' | 'created_at' | 'updated_at' | 'display_order';
  sort_order?: 'asc' | 'desc';
}

export interface CreateFlavorData {
  name: string;
  description?: string;
  colorHex: string;
  displayOrder?: number;
  isActive: boolean;
}

export interface UpdateFlavorData {
  name?: string;
  description?: string;
  colorHex?: string;
  displayOrder?: number;
  isActive?: boolean;
}

/** Mirrors auth.types.ts's AuthError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class FlavorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'FlavorError';
  }
}
