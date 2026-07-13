import type { EmploymentType, Role } from '@potato-corner/shared';

export interface EmployeeListFilters {
  role?: Role;
  employmentType?: EmploymentType;
  isActive?: boolean;
  /** Branch scoping — supervisor callers are restricted to their JWT branch_ids (optionally narrowed further by a branch_id query param); super_admin omits this entirely. */
  branchIds?: string[];
  /** Supervisor callers never see super_admin rows — applied at the query level (not filtered post-fetch) so `total`/pagination stay accurate. */
  excludeRoles?: Role[];
  search?: string;
  page: number;
  limit: number;
}

export interface CreateEmployeeData {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: Role;
  employmentType: EmploymentType;
  branchIds: string[];
  employeeId: string;
  /** Pre-hashed (bcrypt) — the service layer never passes a plaintext password to the repository. */
  passwordHash: string;
  /** Pre-encrypted (AES-256-GCM via lib/encryption.ts) — the repository never sees plaintext government IDs. */
  sssNumberEncrypted?: string;
  philhealthNumberEncrypted?: string;
  tinNumberEncrypted?: string;
  pagibigNumberEncrypted?: string;
}

export interface UpdateEmployeeData {
  firstName?: string;
  lastName?: string;
  phone?: string;
  employmentType?: EmploymentType;
  sssNumberEncrypted?: string;
  philhealthNumberEncrypted?: string;
  tinNumberEncrypted?: string;
  pagibigNumberEncrypted?: string;
}

/** lastLoginAt is deliberately absent — the service already has it from the employee record it fetched, so the repository doesn't re-query it here. */
export interface EmployeeActivityData {
  lastTransactionAt: Date | null;
  totalShiftsThisMonth: number;
  totalTransactionsThisMonth: number;
  openFraudAlertsCount: number;
}

/** Mirrors auth.types.ts's AuthError / branches.types.ts's BranchError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class EmployeeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'EmployeeError';
  }
}
