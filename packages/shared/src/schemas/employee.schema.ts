import { z } from 'zod';
import { ROLES, type Role } from '../constants/roles.js';
import { EMPLOYMENT_TYPE, type EmploymentType, EMPLOYEE_STATUS, type EmployeeStatus } from '../constants/status.js';
import { strongPasswordSchema } from './auth.schema.js';

const roleValues = Object.values(ROLES) as [Role, ...Role[]];
const employmentTypeValues = Object.values(EMPLOYMENT_TYPE) as [EmploymentType, ...EmploymentType[]];
const employeeStatusValues = Object.values(EMPLOYEE_STATUS) as [EmployeeStatus, ...EmployeeStatus[]];

/** PC-EMP-[6 digit number], e.g. PC-EMP-000001 — auto-generated, see employees.repository.ts's generateEmployeeId. */
export const employeeIdSchema = z.string().regex(/^PC-EMP-\d{6}$/, 'Employee ID must match PC-EMP-XXXXXX');

/** +63XXXXXXXXXX — Philippine mobile format. */
export const philippineMobileSchema = z
  .string()
  .regex(/^\+63\d{10}$/, 'Phone must be in +63XXXXXXXXXX format');

/**
 * Wire-format fields are snake_case (first_name, employment_type,
 * branch_ids, initial_password, …), matching the auth module's convention
 * rather than the rest of the app's camelCase REST convention — this
 * module's request/response shapes were specified that way in the Phase 5
 * spec and are kept internally consistent with it.
 *
 * Branch Employee Authorization: `staff` rows are Employees, not logins —
 * they never have credentials. email/initial_password are only required
 * when creating a non-staff (branch/supervisor/super_admin) account, which
 * still authenticates normally. Enforced by the refinement below rather
 * than a discriminated union so the single object shape stays convenient
 * for both the shared create form and the super-admin-only account path.
 */
export const createEmployeeSchema = z
  .object({
    email: z.email().optional(),
    first_name: z.string().min(2).max(50),
    last_name: z.string().min(2).max(50),
    phone: philippineMobileSchema.optional(),
    role: z.enum(roleValues),
    employment_type: z.enum(employmentTypeValues),
    branch_ids: z.array(z.uuid()).min(1),
    // Required only for `staff` (Employee position/job title, e.g.
    // "Cashier") — meaningless for branch/supervisor/super_admin accounts.
    position: z.string().min(2).max(100).optional(),
    notes: z.string().max(1000).optional(),
    // Government ID fields are plaintext on input; the service layer encrypts before storage.
    sss_number: z.string().optional(),
    philhealth_number: z.string().optional(),
    tin_number: z.string().optional(),
    pagibig_number: z.string().optional(),
    initial_password: z.string().min(8).optional(),
  })
  .refine((data) => data.role === ROLES.STAFF || Boolean(data.email), {
    message: 'Email is required for a non-staff account',
    path: ['email'],
  })
  .refine((data) => data.role === ROLES.STAFF || Boolean(data.initial_password), {
    message: 'An initial password is required for a non-staff account',
    path: ['initial_password'],
  })
  .refine((data) => data.role !== ROLES.STAFF || Boolean(data.position), {
    message: 'Position is required for a staff employee',
    path: ['position'],
  })
  // Branch Employee Authorization: an Employee belongs to exactly one
  // Branch — the multi-branch array shape is kept for branch/supervisor/
  // super_admin accounts, which still span multiple branches.
  .refine((data) => data.role !== ROLES.STAFF || data.branch_ids.length === 1, {
    message: 'An employee must be assigned to exactly one branch',
    path: ['branch_ids'],
  });

/** role and email are deliberately absent — both are immutable after creation (locked rule). */
export const updateEmployeeSchema = z.object({
  first_name: z.string().min(2).max(50).optional(),
  last_name: z.string().min(2).max(50).optional(),
  phone: philippineMobileSchema.optional(),
  employment_type: z.enum(employmentTypeValues).optional(),
  branch_ids: z.array(z.uuid()).min(1).optional(),
  position: z.string().min(2).max(100).optional(),
  notes: z.string().max(1000).optional(),
  sss_number: z.string().optional(),
  philhealth_number: z.string().optional(),
  tin_number: z.string().optional(),
  pagibig_number: z.string().optional(),
});

export const deactivateEmployeeSchema = z.object({
  reason: z.string().min(10),
  acknowledge_active_shift: z.boolean(),
});

/**
 * CR-003 (Branch Operating System) — full 5-state lifecycle transition,
 * replacing the deactivate/reactivate pair for new callers. reason is
 * required for every non-active target status. acknowledge_active_shift
 * mirrors deactivateEmployeeSchema's override, letting a caller force a
 * non-active transition through an employee's open shift instead of being
 * permanently blocked by it.
 */
export const setEmployeeStatusSchema = z
  .object({
    status: z.enum(employeeStatusValues),
    reason: z.string().min(10).optional(),
    acknowledge_active_shift: z.boolean().optional(),
  })
  .refine((data) => data.status === 'active' || Boolean(data.reason), {
    message: 'A reason is required when setting a non-active status',
    path: ['reason'],
  });

/**
 * Named to avoid colliding with auth.schema.ts's resetPasswordSchema (the
 * self-service "I forgot my password" flow) — this is the distinct
 * Super-Admin-resets-an-employee's-password flow. Both files are re-exported
 * with `export *` from schemas/index.ts, so the names must not collide.
 */
export const resetEmployeePasswordSchema = z.object({
  new_password: strongPasswordSchema,
});

export const employeeBranchAssignmentSchema = z.object({
  branch_id: z.uuid(),
  branch_name: z.string(),
  branch_code: z.string(),
  assigned_at: z.iso.datetime(),
});

/**
 * Never includes government ID fields — see employeePayrollResponseSchema
 * for the Super-Admin-only decrypted variant. email is nullable — `staff`
 * rows (Employees) have no login credentials at all (Branch Employee
 * Authorization); only branch/supervisor/super_admin accounts have one.
 */
export const employeeResponseSchema = z.object({
  id: z.uuid(),
  email: z.email().nullable(),
  first_name: z.string(),
  last_name: z.string(),
  phone: z.string().nullable(),
  role: z.enum(roleValues),
  employment_type: z.enum(employmentTypeValues),
  employee_id: employeeIdSchema,
  position: z.string().nullable(),
  notes: z.string().nullable(),
  is_active: z.boolean(),
  status: z.enum(employeeStatusValues),
  must_change_password: z.boolean(),
  branch_assignments: z.array(employeeBranchAssignmentSchema),
  last_login_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
});

export const employeePayrollResponseSchema = employeeResponseSchema.extend({
  sss_number: z.string().nullable(),
  philhealth_number: z.string().nullable(),
  tin_number: z.string().nullable(),
  pagibig_number: z.string().nullable(),
});

export const employeeListResponseSchema = z.object({
  employees: z.array(employeeResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

export const employeeActivityResponseSchema = z.object({
  last_login_at: z.iso.datetime().nullable(),
  last_transaction_at: z.iso.datetime().nullable(),
  total_shifts_this_month: z.number().int(),
  total_transactions_this_month: z.number().int(),
  open_fraud_alerts_count: z.number().int(),
});
