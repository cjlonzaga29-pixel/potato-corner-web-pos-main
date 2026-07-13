import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import { ROLES } from '@potato-corner/shared';

vi.mock('./employees.repository.js', () => ({
  employeesRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findWithGovernmentIds: vi.fn(),
    findByBranchIds: vi.fn(),
    generateEmployeeId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deactivate: vi.fn(),
    reactivate: vi.fn(),
    updateBranchAssignments: vi.fn(),
    hasActiveShift: vi.fn(),
    getActivity: vi.fn(),
  },
}));

vi.mock('../../lib/encryption.js', () => ({
  encryptField: vi.fn((value: string) => `encrypted(${value})`),
  decryptField: vi.fn((value: string) => value.replace(/^encrypted\((.*)\)$/, '$1')),
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../queues/notification.queue.js', () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../auth/auth.repository.js', () => ({
  authRepository: {
    revokeAllUserTokens: vi.fn().mockResolvedValue(undefined),
    updatePasswordHash: vi.fn().mockResolvedValue(undefined),
    setMustChangePassword: vi.fn().mockResolvedValue(undefined),
  },
}));

const { employeesRepository } = await import('./employees.repository.js');
const { employeesService } = await import('./employees.service.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { authRepository } = await import('../auth/auth.repository.js');
const { encryptField } = await import('../../lib/encryption.js');

const ACTOR = { id: 'admin-1', role: ROLES.SUPER_ADMIN };

const SUPER_ADMIN_USER = {
  user_id: 'admin-1',
  role: ROLES.SUPER_ADMIN,
  email: 'admin@test.com',
  iat: 0,
  exp: 9999999999,
} as const;

const SUPERVISOR_USER = {
  user_id: 'sup-1',
  role: ROLES.SUPERVISOR,
  email: 'sup@test.com',
  branch_ids: ['branch-a', 'branch-b'] as string[],
  iat: 0,
  exp: 9999999999,
};

function buildEmployee(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'emp-1',
    email: 'juan@potatocorner.test',
    firstName: 'Juan',
    lastName: 'Dela Cruz',
    phone: null,
    role: ROLES.STAFF,
    employmentType: 'regular',
    employeeId: 'PC-EMP-000001',
    isActive: true,
    mustChangePassword: true,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    branchAssignments: [
      { branchId: 'branch-a', assignedAt: new Date('2026-01-01T00:00:00.000Z'), branch: { name: 'Main', code: 'PC-MNL-001' } },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('employeesService.createEmployee', () => {
  it('generates the employee ID via the repository and reflects the PC-EMP-XXXXXX format in the response', async () => {
    vi.mocked(employeesRepository.findByEmail).mockResolvedValue(null);
    vi.mocked(employeesRepository.generateEmployeeId).mockResolvedValue('PC-EMP-000042');
    vi.mocked(employeesRepository.create).mockResolvedValue(buildEmployee({ employeeId: 'PC-EMP-000042' }) as never);

    const result = await employeesService.createEmployee(
      {
        email: 'juan@potatocorner.test',
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        role: ROLES.STAFF,
        employment_type: 'regular',
        branch_ids: ['branch-a'],
        initial_password: 'Password1!',
      } as never,
      ACTOR,
      null,
    );

    expect(employeesRepository.generateEmployeeId).toHaveBeenCalled();
    expect(result.employee_id).toMatch(/^PC-EMP-\d{6}$/);
  });

  it('hashes the initial password with bcrypt before storage', async () => {
    vi.mocked(employeesRepository.findByEmail).mockResolvedValue(null);
    vi.mocked(employeesRepository.generateEmployeeId).mockResolvedValue('PC-EMP-000001');
    vi.mocked(employeesRepository.create).mockResolvedValue(buildEmployee() as never);

    await employeesService.createEmployee(
      {
        email: 'juan@potatocorner.test',
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        role: ROLES.STAFF,
        employment_type: 'regular',
        branch_ids: ['branch-a'],
        initial_password: 'Password1!',
      } as never,
      ACTOR,
      null,
    );

    const createCall = vi.mocked(employeesRepository.create).mock.calls[0]?.[0];
    expect(createCall?.passwordHash).not.toBe('Password1!');
    expect(await bcrypt.compare('Password1!', createCall?.passwordHash ?? '')).toBe(true);
  });

  it('encrypts every provided government ID field before storage', async () => {
    vi.mocked(employeesRepository.findByEmail).mockResolvedValue(null);
    vi.mocked(employeesRepository.generateEmployeeId).mockResolvedValue('PC-EMP-000001');
    vi.mocked(employeesRepository.create).mockResolvedValue(buildEmployee() as never);

    await employeesService.createEmployee(
      {
        email: 'juan@potatocorner.test',
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        role: ROLES.STAFF,
        employment_type: 'regular',
        branch_ids: ['branch-a'],
        initial_password: 'Password1!',
        sss_number: '01-2345678-9',
        philhealth_number: 'PH-1',
        tin_number: 'TIN-1',
        pagibig_number: 'PAG-1',
      } as never,
      ACTOR,
      null,
    );

    expect(encryptField).toHaveBeenCalledWith('01-2345678-9');
    expect(encryptField).toHaveBeenCalledWith('PH-1');
    expect(encryptField).toHaveBeenCalledWith('TIN-1');
    expect(encryptField).toHaveBeenCalledWith('PAG-1');

    const createCall = vi.mocked(employeesRepository.create).mock.calls[0]?.[0];
    expect(createCall?.sssNumberEncrypted).toBe('encrypted(01-2345678-9)');
  });

  it("sets must_change_password to true in the created employee's response", async () => {
    vi.mocked(employeesRepository.findByEmail).mockResolvedValue(null);
    vi.mocked(employeesRepository.generateEmployeeId).mockResolvedValue('PC-EMP-000001');
    vi.mocked(employeesRepository.create).mockResolvedValue(buildEmployee({ mustChangePassword: true }) as never);

    const result = await employeesService.createEmployee(
      {
        email: 'juan@potatocorner.test',
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        role: ROLES.STAFF,
        employment_type: 'regular',
        branch_ids: ['branch-a'],
        initial_password: 'Password1!',
      } as never,
      ACTOR,
      null,
    );

    expect(result.must_change_password).toBe(true);
  });

  it('rejects a duplicate email without calling create', async () => {
    vi.mocked(employeesRepository.findByEmail).mockResolvedValue(buildEmployee() as never);

    await expect(
      employeesService.createEmployee(
        {
          email: 'juan@potatocorner.test',
          first_name: 'Juan',
          last_name: 'Dela Cruz',
          role: ROLES.STAFF,
          employment_type: 'regular',
          branch_ids: ['branch-a'],
          initial_password: 'Password1!',
        } as never,
        ACTOR,
        null,
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_ALREADY_EXISTS', statusCode: 409 });

    expect(employeesRepository.create).not.toHaveBeenCalled();
  });

  it('never leaks government ID values into the audit log entry', async () => {
    vi.mocked(employeesRepository.findByEmail).mockResolvedValue(null);
    vi.mocked(employeesRepository.generateEmployeeId).mockResolvedValue('PC-EMP-000001');
    vi.mocked(employeesRepository.create).mockResolvedValue(buildEmployee() as never);

    await employeesService.createEmployee(
      {
        email: 'juan@potatocorner.test',
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        role: ROLES.STAFF,
        employment_type: 'regular',
        branch_ids: ['branch-a'],
        initial_password: 'Password1!',
        sss_number: '01-2345678-9',
      } as never,
      ACTOR,
      null,
    );

    const auditCall = vi.mocked(recordAuditLog).mock.calls[0]?.[0];
    expect(JSON.stringify(auditCall)).not.toContain('01-2345678-9');
    expect(JSON.stringify(auditCall)).not.toContain('Password1!');
  });
});

describe('employeesService.getEmployeePayrollData', () => {
  it('returns decrypted government IDs only for super_admin', async () => {
    await expect(
      employeesService.getEmployeePayrollData('emp-1', SUPERVISOR_USER, null),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });

    expect(employeesRepository.findWithGovernmentIds).not.toHaveBeenCalled();

    vi.mocked(employeesRepository.findWithGovernmentIds).mockResolvedValue(
      buildEmployee({
        sssNumberEncrypted: 'encrypted(01-2345678-9)',
        philhealthNumberEncrypted: null,
        tinNumberEncrypted: null,
        pagibigNumberEncrypted: null,
      }) as never,
    );

    const result = await employeesService.getEmployeePayrollData('emp-1', SUPER_ADMIN_USER, '127.0.0.1');
    expect(result.sss_number).toBe('01-2345678-9');
    expect(result.philhealth_number).toBeNull();
  });

  it('records a PAYROLL_DATA_ACCESSED audit log entry that never contains the decrypted values', async () => {
    vi.mocked(employeesRepository.findWithGovernmentIds).mockResolvedValue(
      buildEmployee({ sssNumberEncrypted: 'encrypted(01-2345678-9)' }) as never,
    );

    await employeesService.getEmployeePayrollData('emp-1', SUPER_ADMIN_USER, '127.0.0.1');

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYROLL_DATA_ACCESSED', entityId: 'emp-1', actorId: 'admin-1' }),
    );
    const auditCall = vi.mocked(recordAuditLog).mock.calls[0]?.[0];
    expect(JSON.stringify(auditCall)).not.toContain('01-2345678-9');
    expect((auditCall?.afterState as { fieldsAccessed: string[] }).fieldsAccessed).toContain('sss_number');
  });
});

describe('employeesService.getAllEmployees', () => {
  it('for a supervisor returns only employees at their assigned branches', async () => {
    vi.mocked(employeesRepository.findAll).mockResolvedValue({ employees: [], total: 0 });

    await employeesService.getAllEmployees(SUPERVISOR_USER, { page: 1, limit: 25 });

    expect(employeesRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ branchIds: ['branch-a', 'branch-b'] }),
    );
  });

  it('for a supervisor excludes super_admin role employees at the query level', async () => {
    vi.mocked(employeesRepository.findAll).mockResolvedValue({ employees: [], total: 0 });

    await employeesService.getAllEmployees(SUPERVISOR_USER, { page: 1, limit: 25 });

    expect(employeesRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ excludeRoles: [ROLES.SUPER_ADMIN] }),
    );
  });

  it('for a super_admin does not restrict by branch or exclude any role', async () => {
    vi.mocked(employeesRepository.findAll).mockResolvedValue({ employees: [], total: 0 });

    await employeesService.getAllEmployees(SUPER_ADMIN_USER, { page: 1, limit: 25 });

    const callArgs = vi.mocked(employeesRepository.findAll).mock.calls[0]?.[0];
    expect(callArgs?.branchIds).toBeUndefined();
    expect(callArgs?.excludeRoles).toBeUndefined();
  });
});

describe('employeesService.deactivateEmployee', () => {
  it('with an active shift and acknowledge_active_shift false throws and does not deactivate', async () => {
    vi.mocked(employeesRepository.findById).mockResolvedValue(buildEmployee({ isActive: true }) as never);
    vi.mocked(employeesRepository.hasActiveShift).mockResolvedValue(true);

    await expect(
      employeesService.deactivateEmployee('emp-1', { reason: 'Policy violation reported', acknowledge_active_shift: false }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'ACTIVE_SHIFT_ACKNOWLEDGMENT_REQUIRED', statusCode: 409 });

    expect(employeesRepository.deactivate).not.toHaveBeenCalled();
  });

  it('with an active shift and acknowledge_active_shift true proceeds', async () => {
    vi.mocked(employeesRepository.findById)
      .mockResolvedValueOnce(buildEmployee({ isActive: true }) as never)
      .mockResolvedValueOnce(buildEmployee({ isActive: false, branchAssignments: [] }) as never);
    vi.mocked(employeesRepository.hasActiveShift).mockResolvedValue(true);
    vi.mocked(employeesRepository.deactivate).mockResolvedValue(buildEmployee({ isActive: false }) as never);
    vi.mocked(employeesRepository.updateBranchAssignments).mockResolvedValue([]);

    const result = await employeesService.deactivateEmployee(
      'emp-1',
      { reason: 'Policy violation reported', acknowledge_active_shift: true },
      ACTOR,
      null,
    );

    expect(employeesRepository.deactivate).toHaveBeenCalledWith('emp-1', ACTOR.id, 'Policy violation reported');
    expect(result.is_active).toBe(false);
  });

  it('blacklists all active tokens for the deactivated user', async () => {
    vi.mocked(employeesRepository.findById)
      .mockResolvedValueOnce(buildEmployee({ isActive: true }) as never)
      .mockResolvedValueOnce(buildEmployee({ isActive: false, branchAssignments: [] }) as never);
    vi.mocked(employeesRepository.hasActiveShift).mockResolvedValue(false);
    vi.mocked(employeesRepository.deactivate).mockResolvedValue(buildEmployee({ isActive: false }) as never);
    vi.mocked(employeesRepository.updateBranchAssignments).mockResolvedValue([]);

    await employeesService.deactivateEmployee('emp-1', { reason: 'No longer employed here', acknowledge_active_shift: false }, ACTOR, null);

    expect(authRepository.revokeAllUserTokens).toHaveBeenCalledWith('emp-1');
    expect(employeesRepository.updateBranchAssignments).toHaveBeenCalledWith('emp-1', [], ACTOR.id);
  });

  it('rejects deactivating an already-inactive employee', async () => {
    vi.mocked(employeesRepository.findById).mockResolvedValue(buildEmployee({ isActive: false }) as never);

    await expect(
      employeesService.deactivateEmployee('emp-1', { reason: 'Duplicate request test', acknowledge_active_shift: false }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_ALREADY_INACTIVE', statusCode: 409 });
  });
});

describe('employeesService.reactivateEmployee', () => {
  it("sets must_change_password to true in the reactivated employee's response", async () => {
    vi.mocked(employeesRepository.findById).mockResolvedValue(buildEmployee({ isActive: false }) as never);
    vi.mocked(employeesRepository.reactivate).mockResolvedValue(
      buildEmployee({ isActive: true, mustChangePassword: true }) as never,
    );

    const result = await employeesService.reactivateEmployee('emp-1', ACTOR, null);

    expect(result.must_change_password).toBe(true);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'EMPLOYEE_REACTIVATED' }));
  });

  it('rejects reactivating an already-active employee', async () => {
    vi.mocked(employeesRepository.findById).mockResolvedValue(buildEmployee({ isActive: true }) as never);

    await expect(employeesService.reactivateEmployee('emp-1', ACTOR, null)).rejects.toMatchObject({
      code: 'EMPLOYEE_ALREADY_ACTIVE',
      statusCode: 409,
    });
  });
});

describe('EmployeeResponse never includes government ID fields', () => {
  it('getEmployeeById strips any government ID data even if present on the underlying record', async () => {
    vi.mocked(employeesRepository.findById).mockResolvedValue(
      buildEmployee({ sssNumberEncrypted: 'encrypted(leaked-value)' }) as never,
    );

    const result = await employeesService.getEmployeeById('emp-1', SUPER_ADMIN_USER);

    expect(JSON.stringify(result)).not.toContain('leaked-value');
    expect(result).not.toHaveProperty('sss_number');
    expect(result).not.toHaveProperty('sssNumberEncrypted');
  });
});
