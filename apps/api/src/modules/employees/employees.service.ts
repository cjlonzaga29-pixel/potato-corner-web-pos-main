import bcrypt from 'bcrypt';
import {
  ROLES,
  type CreateEmployeeInput,
  type DeactivateEmployeeInput,
  type EmployeeActivityResponse,
  type EmployeeListResponse,
  type EmployeePayrollResponse,
  type EmployeeResponse,
  type EmploymentType,
  type JwtPayload,
  type Role,
  type UpdateEmployeeInput,
} from '@potato-corner/shared';
import { employeesRepository, type EmployeeWithAssignments, type EmployeeWithGovernmentIds } from './employees.repository.js';
import { EmployeeError } from './employees.types.js';
import { encryptField, decryptField } from '../../lib/encryption.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { enqueueRawNotificationJob } from '../../queues/notification.queue.js';
import { authRepository } from '../auth/auth.repository.js';
import { getAccessibleBranchIds } from '../../lib/branch-access.js';

const BCRYPT_COST_FACTOR = 12;

export interface EmployeeListQuery {
  role?: Role;
  employmentType?: EmploymentType;
  isActive?: boolean;
  branchId?: string;
  search?: string;
  page: number;
  limit: number;
}

type ActorContext = JwtPayload;

function toEmployeeResponse(employee: EmployeeWithAssignments): EmployeeResponse {
  return {
    id: employee.id,
    email: employee.email,
    first_name: employee.firstName,
    last_name: employee.lastName,
    phone: employee.phone,
    role: employee.role,
    employment_type: employee.employmentType,
    employee_id: employee.employeeId ?? '',
    is_active: employee.isActive,
    status: employee.status,
    must_change_password: employee.mustChangePassword,
    branch_assignments: employee.branchAssignments.map((assignment) => ({
      branch_id: assignment.branchId,
      branch_name: assignment.branch.name,
      branch_code: assignment.branch.code,
      assigned_at: assignment.assignedAt.toISOString(),
    })),
    last_login_at: employee.lastLoginAt ? employee.lastLoginAt.toISOString() : null,
    created_at: employee.createdAt.toISOString(),
  };
}

/** super_admin sees everything; supervisor is scoped to their JWT branch_ids — never trust a client-supplied branch list. */
function assertEmployeeAccess(requestingUser: JwtPayload, employee: EmployeeWithAssignments): void {
  const accessible = getAccessibleBranchIds(requestingUser);
  if (accessible === 'all') return;
  const hasAccess = employee.branchAssignments.some((assignment) => accessible.includes(assignment.branchId));
  if (!hasAccess) {
    throw new EmployeeError('EMPLOYEE_ACCESS_DENIED', 'You do not have access to this employee', 403);
  }
}

export const employeesService = {
  async getAllEmployees(requestingUser: JwtPayload, filters: EmployeeListQuery): Promise<EmployeeListResponse> {
    const accessible = getAccessibleBranchIds(requestingUser);
    let branchIds: string[] | undefined;
    let excludeRoles: Role[] | undefined;

    if (accessible === 'all') {
      branchIds = filters.branchId ? [filters.branchId] : undefined;
    } else {
      // Router gates this endpoint to adminOrSupervisor, so any non-super_admin caller here is a supervisor.
      if (filters.branchId && !accessible.includes(filters.branchId)) {
        throw new EmployeeError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
      }
      branchIds = filters.branchId ? [filters.branchId] : accessible;
      excludeRoles = [ROLES.SUPER_ADMIN];
    }

    const { employees, total } = await employeesRepository.findAll({
      role: filters.role,
      employmentType: filters.employmentType,
      isActive: filters.isActive,
      branchIds,
      excludeRoles,
      search: filters.search,
      page: filters.page,
      limit: filters.limit,
    });

    return {
      employees: employees.map(toEmployeeResponse),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },

  async getEmployeeById(employeeId: string, requestingUser: JwtPayload): Promise<EmployeeResponse> {
    const employee = await employeesRepository.findById(employeeId);
    if (!employee) throw new EmployeeError('EMPLOYEE_NOT_FOUND', 'Employee not found', 404);

    assertEmployeeAccess(requestingUser, employee);
    return toEmployeeResponse(employee);
  },

  async getEmployeePayrollData(
    employeeId: string,
    requestingUser: JwtPayload,
    ipAddress: string | null,
  ): Promise<EmployeePayrollResponse> {
    if (requestingUser.role !== ROLES.SUPER_ADMIN) {
      throw new EmployeeError('INSUFFICIENT_PERMISSIONS', 'Only Super Admin may access payroll data', 403);
    }

    const employee: EmployeeWithGovernmentIds | null = await employeesRepository.findWithGovernmentIds(employeeId);
    if (!employee) throw new EmployeeError('EMPLOYEE_NOT_FOUND', 'Employee not found', 404);

    // Records WHICH fields were decrypted, never the decrypted values themselves (locked rule).
    const fieldsAccessed: string[] = [];
    function decrypt(field: string, encrypted: string | null): string | null {
      if (!encrypted) return null;
      fieldsAccessed.push(field);
      return decryptField(encrypted);
    }

    const payroll: EmployeePayrollResponse = {
      ...toEmployeeResponse(employee),
      sss_number: decrypt('sss_number', employee.sssNumberEncrypted),
      philhealth_number: decrypt('philhealth_number', employee.philhealthNumberEncrypted),
      tin_number: decrypt('tin_number', employee.tinNumberEncrypted),
      pagibig_number: decrypt('pagibig_number', employee.pagibigNumberEncrypted),
    };

    await recordAuditLog({
      action: 'PAYROLL_DATA_ACCESSED',
      entityType: 'user',
      entityId: employeeId,
      actorId: requestingUser.user_id,
      actorRole: requestingUser.role,
      afterState: { fieldsAccessed },
      ipAddress,
    });

    return payroll;
  },

  async createEmployee(data: CreateEmployeeInput, createdBy: ActorContext, ipAddress: string | null): Promise<EmployeeResponse> {
    const existing = await employeesRepository.findByEmail(data.email);
    if (existing) {
      throw new EmployeeError('EMAIL_ALREADY_EXISTS', 'An account with this email already exists', 409);
    }

    // Router permits both supervisor and branch actors here (adminOrBranch /
    // adminSupervisorOrBranch) — only super_admin may create a non-staff
    // account or assign branches outside the actor's own branch_ids.
    if (createdBy.role === ROLES.SUPERVISOR || createdBy.role === ROLES.BRANCH) {
      if (data.role !== ROLES.STAFF) {
        throw new EmployeeError('INSUFFICIENT_PERMISSIONS', 'Only Super Admin may create a non-staff account', 403);
      }
      const outOfScope = data.branch_ids.some((id) => !createdBy.branch_ids.includes(id));
      if (outOfScope) {
        throw new EmployeeError('BRANCH_ACCESS_DENIED', 'You do not have access to one or more of the requested branches', 400);
      }
    }

    const employeeId = await employeesRepository.generateEmployeeId();
    const passwordHash = await bcrypt.hash(data.initial_password, BCRYPT_COST_FACTOR);

    const employee = await employeesRepository.create({
      email: data.email,
      firstName: data.first_name,
      lastName: data.last_name,
      phone: data.phone,
      role: data.role,
      employmentType: data.employment_type,
      branchIds: data.branch_ids,
      employeeId,
      passwordHash,
      sssNumberEncrypted: data.sss_number ? encryptField(data.sss_number) : undefined,
      philhealthNumberEncrypted: data.philhealth_number ? encryptField(data.philhealth_number) : undefined,
      tinNumberEncrypted: data.tin_number ? encryptField(data.tin_number) : undefined,
      pagibigNumberEncrypted: data.pagibig_number ? encryptField(data.pagibig_number) : undefined,
    });

    await recordAuditLog({
      action: 'EMPLOYEE_CREATED',
      entityType: 'user',
      entityId: employee.id,
      actorId: createdBy.user_id,
      actorRole: createdBy.role,
      afterState: {
        email: employee.email,
        employeeId: employee.employeeId,
        role: employee.role,
        employmentType: employee.employmentType,
        branchIds: data.branch_ids,
      },
      ipAddress,
    });

    // Best-effort — a failed welcome email must never fail employee creation itself.
    // Phase 21: runs in-process now (no queue), so the temporary password only
    // lives as long as this call's in-memory closure, not a persisted job record.
    await enqueueRawNotificationJob('employee_welcome', {
      toEmail: employee.email,
      firstName: employee.firstName,
      employeeId: employee.employeeId,
      tempPassword: data.initial_password,
    }).catch((error: unknown) => {
      console.error('Failed to enqueue welcome email:', error);
    });

    return toEmployeeResponse(employee);
  },

  async updateEmployee(
    employeeId: string,
    data: UpdateEmployeeInput,
    updatedBy: ActorContext,
    ipAddress: string | null,
  ): Promise<EmployeeResponse> {
    const before = await employeesRepository.findById(employeeId);
    if (!before) throw new EmployeeError('EMPLOYEE_NOT_FOUND', 'Employee not found', 404);
    assertEmployeeAccess(updatedBy, before);

    if (data.branch_ids) {
      const accessible = getAccessibleBranchIds(updatedBy);
      if (accessible !== 'all') {
        const outOfScope = data.branch_ids.some((id) => !accessible.includes(id));
        if (outOfScope) {
          throw new EmployeeError('BRANCH_ACCESS_DENIED', 'You do not have access to one or more of the requested branches', 400);
        }
      }
      await employeesRepository.updateBranchAssignments(employeeId, data.branch_ids, updatedBy.user_id);
    }

    const employee = await employeesRepository.update(employeeId, {
      firstName: data.first_name,
      lastName: data.last_name,
      phone: data.phone,
      employmentType: data.employment_type,
      sssNumberEncrypted: data.sss_number ? encryptField(data.sss_number) : undefined,
      philhealthNumberEncrypted: data.philhealth_number ? encryptField(data.philhealth_number) : undefined,
      tinNumberEncrypted: data.tin_number ? encryptField(data.tin_number) : undefined,
      pagibigNumberEncrypted: data.pagibig_number ? encryptField(data.pagibig_number) : undefined,
    });

    await recordAuditLog({
      action: 'EMPLOYEE_UPDATED',
      entityType: 'user',
      entityId: employeeId,
      actorId: updatedBy.user_id,
      actorRole: updatedBy.role,
      beforeState: toEmployeeResponse(before),
      afterState: toEmployeeResponse(employee),
      ipAddress,
    });

    return toEmployeeResponse(employee);
  },

  async deactivateEmployee(
    employeeId: string,
    data: DeactivateEmployeeInput,
    deactivatedBy: ActorContext,
    ipAddress: string | null,
  ): Promise<EmployeeResponse> {
    const before = await employeesRepository.findById(employeeId);
    if (!before) throw new EmployeeError('EMPLOYEE_NOT_FOUND', 'Employee not found', 404);
    assertEmployeeAccess(deactivatedBy, before);
    if (!before.isActive) throw new EmployeeError('EMPLOYEE_ALREADY_INACTIVE', 'This employee is already deactivated', 409);

    const hasActiveShift = await employeesRepository.hasActiveShift(employeeId);
    if (hasActiveShift && !data.acknowledge_active_shift) {
      throw new EmployeeError(
        'ACTIVE_SHIFT_ACKNOWLEDGMENT_REQUIRED',
        'This employee has an active shift — acknowledge to proceed with deactivation',
        409,
        { hasActiveShift: true },
      );
    }

    await employeesRepository.deactivate(employeeId, deactivatedBy.user_id, data.reason);
    await authRepository.revokeAllUserTokens(employeeId);
    await employeesRepository.updateBranchAssignments(employeeId, [], deactivatedBy.user_id);

    const employee = await employeesRepository.findById(employeeId);
    if (!employee) throw new EmployeeError('EMPLOYEE_NOT_FOUND', 'Employee not found', 404);

    await recordAuditLog({
      action: 'EMPLOYEE_DEACTIVATED',
      entityType: 'user',
      entityId: employeeId,
      actorId: deactivatedBy.user_id,
      actorRole: deactivatedBy.role,
      beforeState: { isActive: true },
      afterState: { isActive: false, reason: data.reason, hadActiveShift: hasActiveShift },
      ipAddress,
    });

    return toEmployeeResponse(employee);
  },

  async reactivateEmployee(employeeId: string, reactivatedBy: ActorContext, ipAddress: string | null): Promise<EmployeeResponse> {
    const before = await employeesRepository.findById(employeeId);
    if (!before) throw new EmployeeError('EMPLOYEE_NOT_FOUND', 'Employee not found', 404);
    assertEmployeeAccess(reactivatedBy, before);
    if (before.isActive) throw new EmployeeError('EMPLOYEE_ALREADY_ACTIVE', 'This employee is already active', 409);

    const employee = await employeesRepository.reactivate(employeeId, reactivatedBy.user_id);

    await recordAuditLog({
      action: 'EMPLOYEE_REACTIVATED',
      entityType: 'user',
      entityId: employeeId,
      actorId: reactivatedBy.user_id,
      actorRole: reactivatedBy.role,
      beforeState: { isActive: false },
      afterState: { isActive: true },
      ipAddress,
    });

    return toEmployeeResponse(employee);
  },

  /**
   * CR-003 (Branch Operating System) — full 5-state lifecycle transition.
   * Any non-active target immediately revokes every outstanding refresh
   * token (forces re-login on next refresh attempt) and, per the spec,
   * blocks POS/attendance access — both already enforced by the existing
   * isActive-gated checks in auth.service.ts, cash.service.ts and
   * attendance.service.ts, since setStatus keeps isActive in sync.
   */
  async setEmployeeStatus(
    employeeId: string,
    status: 'active' | 'inactive' | 'suspended' | 'resigned' | 'terminated',
    reason: string | null,
    changedBy: ActorContext,
    ipAddress: string | null,
  ): Promise<EmployeeResponse> {
    const before = await employeesRepository.findById(employeeId);
    if (!before) throw new EmployeeError('EMPLOYEE_NOT_FOUND', 'Employee not found', 404);
    assertEmployeeAccess(changedBy, before);
    if (before.status === status) {
      throw new EmployeeError('EMPLOYEE_STATUS_UNCHANGED', `This employee is already ${status}`, 409);
    }

    if (status !== 'active') {
      const hasActiveShift = await employeesRepository.hasActiveShift(employeeId);
      if (hasActiveShift) {
        throw new EmployeeError(
          'ACTIVE_SHIFT_ACKNOWLEDGMENT_REQUIRED',
          'This employee has an active shift — close it before changing status',
          409,
          { hasActiveShift: true },
        );
      }
    }

    await employeesRepository.setStatus(employeeId, status, changedBy.user_id, reason);

    if (status !== 'active') {
      // Force logout: refresh revocation blocks re-auth immediately; the
      // employee's current (short-lived) access token expires on its own.
      await authRepository.revokeAllUserTokens(employeeId);
      await employeesRepository.updateBranchAssignments(employeeId, [], changedBy.user_id);
    }

    const employee = await employeesRepository.findById(employeeId);
    if (!employee) throw new EmployeeError('EMPLOYEE_NOT_FOUND', 'Employee not found', 404);

    await recordAuditLog({
      action: 'EMPLOYEE_STATUS_CHANGED',
      entityType: 'user',
      entityId: employeeId,
      actorId: changedBy.user_id,
      actorRole: changedBy.role,
      beforeState: { status: before.status },
      afterState: { status, reason },
      ipAddress,
    });

    return toEmployeeResponse(employee);
  },

  async resetEmployeePassword(
    employeeId: string,
    newPassword: string,
    resetBy: ActorContext,
    ipAddress: string | null,
  ): Promise<void> {
    const employee = await employeesRepository.findById(employeeId);
    if (!employee) throw new EmployeeError('EMPLOYEE_NOT_FOUND', 'Employee not found', 404);
    assertEmployeeAccess(resetBy, employee);

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST_FACTOR);
    await authRepository.updatePasswordHash(employeeId, passwordHash);
    await authRepository.setMustChangePassword(employeeId, true);
    await authRepository.revokeAllUserTokens(employeeId);

    await recordAuditLog({
      action: 'PASSWORD_RESET_BY_ADMIN',
      entityType: 'user',
      entityId: employeeId,
      actorId: resetBy.user_id,
      actorRole: resetBy.role,
      ipAddress,
    });
  },

  async getEmployeeActivity(employeeId: string, requestingUser: JwtPayload): Promise<EmployeeActivityResponse> {
    const employee = await employeesRepository.findById(employeeId);
    if (!employee) throw new EmployeeError('EMPLOYEE_NOT_FOUND', 'Employee not found', 404);

    assertEmployeeAccess(requestingUser, employee);

    const activity = await employeesRepository.getActivity(employeeId);

    return {
      last_login_at: employee.lastLoginAt ? employee.lastLoginAt.toISOString() : null,
      last_transaction_at: activity.lastTransactionAt ? activity.lastTransactionAt.toISOString() : null,
      total_shifts_this_month: activity.totalShiftsThisMonth,
      total_transactions_this_month: activity.totalTransactionsThisMonth,
      open_fraud_alerts_count: activity.openFraudAlertsCount,
    };
  },
};
