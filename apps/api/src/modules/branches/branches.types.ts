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
  /** Task 174 — when present, the branch's login account is created atomically with the branch itself. */
  account?: { email: string; password: string };
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

/** POS-PERF-P67 — open work that must be finished before a branch can be deleted. */
export type BranchDeletionBlockerCode =
  | 'open_shifts'
  | 'open_attendance'
  | 'pending_checkouts'
  | 'held_orders'
  | 'pending_inventory_jobs'
  | 'nonzero_stock'
  | 'draft_payroll_runs'
  | 'unpaid_payroll_hours';

export interface BranchDeletionBlocker {
  code: BranchDeletionBlockerCode;
  count: number;
  message: string;
}

/** Counts of committed operational writes; any change during a delete means someone was still working. */
export type BranchActivityFingerprint = Record<string, number>;

export type BranchDeletionOutcome =
  | { outcome: 'deleted'; branchAccountIds: string[]; removed: Record<string, number> }
  | { outcome: 'not_found' }
  | { outcome: 'changed' }
  | { outcome: 'activity' }
  | { outcome: 'blocked'; blockers: BranchDeletionBlocker[] };
