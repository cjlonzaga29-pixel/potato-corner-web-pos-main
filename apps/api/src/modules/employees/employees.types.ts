import type { EmploymentType, Role } from '@potato-corner/shared';

/** POS-PERF-P47/P66 — history categories attributed to a person (see employeesRepository.countHistoryReferences). Since P66 they never block a delete; they tell the person deciding what stays. */
export type EmployeeHistoryCategory =
  | 'sales'
  | 'shifts'
  | 'attendance'
  | 'audit'
  | 'inventory'
  | 'expenses'
  | 'catalog'
  | 'settings'
  | 'pin_use'
  | 'payroll';

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
  /** Absent for `staff` (Employees never have login credentials) — required for every other role. */
  email?: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: Role;
  employmentType: EmploymentType;
  branchIds: string[];
  employeeId: string;
  /** Required for `staff` at the schema layer (createEmployeeSchema's refinement) — absent for other roles. */
  position?: string;
  notes?: string;
  /** Pre-hashed (bcrypt); absent for `staff`. The service layer never passes a plaintext password to the repository. */
  passwordHash?: string;
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
  position?: string;
  notes?: string;
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

/** POS-PERF-P64/P66 — what stands in the way of deleting an account (see employeesRepository.getRemovalPrerequisites). */
export interface RemovalPrerequisites {
  /** Blocking: close the shift (count the cash) first. */
  open_shifts: { id: string; branch_name: string }[];
  /** Blocking: clock out (or correct the record) first. */
  open_attendance: { id: string; branch_name: string }[];
  /** Informational: held carts expire on their own and stay on their branch. */
  held_orders: number;
  /** Informational: reviewers can still decide them; the requester name is kept. */
  pending_inventory_approvals: number;
  /** Branches whose access is removed. */
  branches: { id: string; name: string }[];
  /** Informational: no other active supervisor is assigned; a Super Admin can assign one. */
  branches_left_without_supervisor: { id: string; name: string }[];
  /**
   * POS-PERF-P66 — blocking, staff only: recorded hours at a branch that uses
   * payroll which no finalized payroll covers yet. Payroll drafts read live
   * accounts, so deleting first would drop those hours from the next draft.
   */
  unpaid_payroll: { branch_id: string; branch_name: string; first_date: string; last_date: string; records: number }[];
}

/** POS-PERF-P66 — what must be resolved before an account can be deleted. */
export function hasBlockingPrerequisites(prerequisites: RemovalPrerequisites): boolean {
  return prerequisites.open_shifts.length > 0 || prerequisites.open_attendance.length > 0 || prerequisites.unpaid_payroll.length > 0;
}
