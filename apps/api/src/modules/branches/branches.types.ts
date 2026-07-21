import type { BranchStatus } from '@potato-corner/shared';

export interface BranchListFilters {
  status?: BranchStatus;
  city?: string;
  search?: string;
  /** Restricts results to these branch IDs — set for supervisor/staff callers, omitted for super_admin. */
  ids?: string[];
  page: number;
  limit: number;
}

export interface CreateBranchData {
  name: string;
  code?: string;
  address: string;
  city: string;
  gpsLatitude?: number;
  gpsLongitude?: number;
  gpsRadiusMeters: number;
  status: BranchStatus;
}

export interface UpdateBranchData {
  name?: string;
  address?: string;
  city?: string;
  gpsLatitude?: number;
  gpsLongitude?: number;
  gpsRadiusMeters?: number;
  status?: BranchStatus;
  gcashQrUrl?: string | null;
  gcashQrKey?: string | null;
}

export interface BranchStatsData {
  activeShiftsCount: number;
  todayTransactionCount: number;
  todayRevenue: number;
  activeStaffCount: number;
  lowStockIngredientCount: number;
}

/** Mirrors auth.types.ts's AuthError — every module maps its own domain errors to HTTP status via its router's error handler, since app.ts's global handler only special-cases AuthError. */
export class BranchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BranchError';
  }
}
