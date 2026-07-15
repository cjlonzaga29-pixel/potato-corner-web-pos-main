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
import { notificationQueue } from '../../queues/notification.queue.js';
import { authRepository } from '../auth/auth.repository.js';

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

interface ActorContext {
  id: string;
  role: string;
}

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
  if (requestingUser.role === ROLES.SUPER_ADMIN) return;
  const hasAccess = employee.branchAssignments.some((assignment) => requestingUser.branch_ids.includes(assignment.branchId));
  if (!hasAccess) {
    throw new EmployeeError('EMPLOYEE_ACCESS_DENIED', 'You do not have access to this employee', 403);
  }
}

export const employeesService = {
  async getAllEmployees(requestingUser: JwtPayload, filters: EmployeeListQuery): Promise<EmployeeListResponse> {
    let branchIds: string[] | undefined;
    let excludeRoles: Role[] | undefined;

    if (requestingUser.role === ROLES.SUPER_ADMIN) {
      branchIds = filters.branchId ? [filters.branchId] : undefined;
    } else {
      // Router gates this endpoint to adminOrSupervisor, so any non-super_admin caller here is a supervisor.
      if (filters.branchId && !requestingUser.branch_ids.includes(filters.branchId)) {
        throw new EmployeeError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
      }
      branchIds = filters.branchId ? [filters.branchId] : requestingUser.branch_ids;
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
      actorId: createdBy.id,
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
    // removeOnComplete/removeOnFail minimize how long the temporary password sits in Redis job data.
    await notificationQueue
      .add(
        'employee_welcome',
        { toEmail: employee.email, firstName: employee.firstName, employeeId: employee.employeeId, tempPassword: data.initial_password },
        { removeOnComplete: true, removeOnFail: true },
      )
      .catch((error: unknown) => {
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

    if (data.branch_ids) {
      await employeesRepository.updateBranchAssignments(employeeId, data.branch_ids, updatedBy.id);
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
      actorId: updatedBy.id,
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

    await employeesRepository.deactivate(employeeId, deactivatedBy.id, data.reason);
    await authRepository.revokeAllUserTokens(employeeId);
    await employeesRepository.updateBranchAssignments(employeeId, [], deactivatedBy.id);

    const employee = await employeesRepository.findById(employeeId);
    if (!employee) throw new EmployeeError('EMPLOYEE_NOT_FOUND', 'Employee not found', 404);

    await recordAuditLog({
      action: 'EMPLOYEE_DEACTIVATED',
      entityType: 'user',
      entityId: employeeId,
      actorId: deactivatedBy.id,
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
    if (before.isActive) throw new EmployeeError('EMPLOYEE_ALREADY_ACTIVE', 'This employee is already active', 409);

    const employee = await employeesRepository.reactivate(employeeId, reactivatedBy.id);

    await recordAuditLog({
      action: 'EMPLOYEE_REACTIVATED',
      entityType: 'user',
      entityId: employeeId,
      actorId: reactivatedBy.id,
      actorRole: reactivatedBy.role,
      beforeState: { isActive: false },
      afterState: { isActive: true },
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

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST_FACTOR);
    await authRepository.updatePasswordHash(employeeId, passwordHash);
    await authRepository.setMustChangePassword(employeeId, true);
    await authRepository.revokeAllUserTokens(employeeId);

    await recordAuditLog({
      action: 'PASSWORD_RESET_BY_ADMIN',
      entityType: 'user',
      entityId: employeeId,
      actorId: resetBy.id,
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
