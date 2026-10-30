import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ROLES } from '@potato-corner/shared';

vi.mock('./settings.repository.js', () => ({
  settingsRepository: {
    findSystemSetting: vi.fn(),
    upsertSystemSetting: vi.fn(),
    writeSystemSettingIfUnchanged: vi.fn(),
    findNotificationPreference: vi.fn(),
    createDefaultNotificationPreference: vi.fn(),
    updateNotificationPreference: vi.fn(),
    findBranchReceiptConfig: vi.fn(),
    upsertBranchReceiptConfig: vi.fn(),
    findPaymentMethodConfig: vi.fn(),
    upsertPaymentMethodConfig: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../branches/branches.repository.js', () => ({
  branchesRepository: {
    findById: vi.fn(),
    findAllActiveBranchIds: vi.fn(),
  },
}));

const { settingsRepository } = await import('./settings.repository.js');
const { settingsService } = await import('./settings.service.js');
const { branchesRepository } = await import('../branches/branches.repository.js');

const ACTOR = {
  user_id: 'admin-1',
  role: ROLES.SUPER_ADMIN,
  email: 'admin@test.com',
  iat: 0,
  exp: 9999999999,
} as const;

const SUPERVISOR_ACTOR = {
  user_id: 'supervisor-1',
  role: ROLES.SUPERVISOR,
  email: 'supervisor@test.com',
  branch_ids: ['branch-1'] as string[],
  iat: 0,
  exp: 9999999999,
} as const;

const OTHER_BRANCH_SUPERVISOR_ACTOR = {
  user_id: 'supervisor-2',
  role: ROLES.SUPERVISOR,
  email: 'supervisor2@test.com',
  branch_ids: ['branch-2'] as string[],
  iat: 0,
  exp: 9999999999,
} as const;

const VALID_SECURITY_POLICY = {
  sessionTimeoutMinutes: 60,
  passwordMinLength: 8,
  requirePasswordComplexity: true,
  require2faForAdmins: false,
  require2faForSupervisors: false,
  maxFailedLoginAttempts: 5,
  lockoutDurationMinutes: 30,
};

function buildNotificationPreference(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'np-1',
    userId: 'user-1',
    emailDigestEnabled: true,
    emailDigestFrequency: 'daily',
    alertFraud: true,
    alertLowStock: true,
    alertCashVariance: true,
    alertVoidRequests: true,
    dndEnabled: false,
    dndStartHour: 22,
    dndEndHour: 7,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildReceiptConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'brc-1',
    branchId: 'branch-1',
    headerText: null,
    footerText: null,
    showBranchLogo: true,
    updatedBy: 'admin-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildPaymentMethodConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'bpmc-1',
    branchId: 'branch-1',
    cashEnabled: true,
    gcashEnabled: true,
    updatedBy: 'admin-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: branch-1 is active — matches SUPERVISOR_ACTOR's old branch_ids
  // and every buildReceiptConfig/buildPaymentMethodConfig's branchId;
  // OTHER_BRANCH_SUPERVISOR_ACTOR's tests expect denial since branch-2 is
  // never in this list.
  vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);
});

describe('settingsService.getSecurityPolicy', () => {
  it('returns defaults when not set', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);

    const policy = await settingsService.getSecurityPolicy();

    expect(policy.sessionTimeoutMinutes).toBe(60);
    expect(policy.maxFailedLoginAttempts).toBe(5);
  });
});

describe('settingsService.updateSecurityPolicy', () => {
  it('persists to SystemSetting table', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);
    vi.mocked(settingsRepository.upsertSystemSetting).mockResolvedValue({
      id: 'setting-1',
      key: 'security_policy',
      value: VALID_SECURITY_POLICY,
      description: null,
      updatedBy: 'admin-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const result = await settingsService.updateSecurityPolicy(VALID_SECURITY_POLICY, ACTOR, null);

    expect(settingsRepository.upsertSystemSetting).toHaveBeenCalledWith(
      'security_policy',
      VALID_SECURITY_POLICY,
      'admin-1',
      expect.any(String),
    );
    expect(result).toEqual(VALID_SECURITY_POLICY);
  });

  it('rejects invalid values (e.g. sessionTimeout < 5)', async () => {
    const { updateSecurityPolicySchema } = await import('@potato-corner/shared');

    const result = updateSecurityPolicySchema.safeParse({ ...VALID_SECURITY_POLICY, sessionTimeoutMinutes: 1 });

    expect(result.success).toBe(false);
  });
});

describe('settingsService.getNotificationPreferences', () => {
  it('creates default record for new user', async () => {
    vi.mocked(settingsRepository.findNotificationPreference).mockResolvedValue(null);
    vi.mocked(settingsRepository.createDefaultNotificationPreference).mockResolvedValue(buildNotificationPreference() as never);

    const result = await settingsService.getNotificationPreferences('user-1');

    expect(settingsRepository.createDefaultNotificationPreference).toHaveBeenCalledWith('user-1');
    expect(result.emailDigestEnabled).toBe(true);
  });
});

describe('settingsService.updateNotificationPreferences', () => {
  it('updates only provided fields', async () => {
    vi.mocked(settingsRepository.findNotificationPreference).mockResolvedValue(buildNotificationPreference() as never);
    vi.mocked(settingsRepository.updateNotificationPreference).mockResolvedValue(
      buildNotificationPreference({ alertFraud: false }) as never,
    );

    const result = await settingsService.updateNotificationPreferences('user-1', { alertFraud: false }, ACTOR, null);

    expect(settingsRepository.updateNotificationPreference).toHaveBeenCalledWith('user-1', { alertFraud: false });
    expect(result.alertFraud).toBe(false);
    expect(result.alertLowStock).toBe(true);
  });

  it('validates dndStartHour and dndEndHour are 0-23', async () => {
    const { updateNotificationPreferencesSchema } = await import('@potato-corner/shared');

    expect(updateNotificationPreferencesSchema.safeParse({ dndStartHour: 24 }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ dndEndHour: -1 }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ dndStartHour: 22, dndEndHour: 7 }).success).toBe(true);
  });
});

describe('settingsService.getBranchReceiptConfig', () => {
  it('returns null if not configured', async () => {
    vi.mocked(settingsRepository.findBranchReceiptConfig).mockResolvedValue(null);

    const result = await settingsService.getBranchReceiptConfig('branch-1');

    expect(result).toBeNull();
  });
});

describe('settingsService.updateBranchReceiptConfig', () => {
  it('upserts record', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue({ id: 'branch-1' } as never);
    vi.mocked(settingsRepository.findBranchReceiptConfig).mockResolvedValue(null);
    vi.mocked(settingsRepository.upsertBranchReceiptConfig).mockResolvedValue(
      buildReceiptConfig({ headerText: 'Welcome' }) as never,
    );

    const result = await settingsService.updateBranchReceiptConfig('branch-1', { headerText: 'Welcome' }, ACTOR, null);

    expect(settingsRepository.upsertBranchReceiptConfig).toHaveBeenCalledWith('branch-1', { headerText: 'Welcome' }, 'admin-1');
    expect(result.headerText).toBe('Welcome');
  });

  it('requires branch to exist', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(null);

    await expect(settingsService.updateBranchReceiptConfig('missing-branch', { headerText: 'x' }, ACTOR, null)).rejects.toThrow(
      'Branch not found',
    );
  });
});

describe('settingsService.getPaymentMethodConfig', () => {
  it('returns null if not configured', async () => {
    vi.mocked(settingsRepository.findPaymentMethodConfig).mockResolvedValue(null);

    const result = await settingsService.getPaymentMethodConfig('branch-1', ACTOR);

    expect(result).toBeNull();
  });

  it('allows a super admin regardless of branch_ids', async () => {
    vi.mocked(settingsRepository.findPaymentMethodConfig).mockResolvedValue(buildPaymentMethodConfig() as never);

    const result = await settingsService.getPaymentMethodConfig('branch-1', ACTOR);

    expect(result?.cashEnabled).toBe(true);
  });

  // Supervisor is organization-wide over every active branch (database-
  // sourced) — no UserBranchAssignment or matching JWT branch_ids required,
  // so OTHER_BRANCH_SUPERVISOR_ACTOR (JWT branch_ids: ['branch-2']) can
  // still reach branch-1 as long as it's active.
  it('allows any supervisor when the branch is active, regardless of their JWT branch_ids', async () => {
    vi.mocked(settingsRepository.findPaymentMethodConfig).mockResolvedValue(buildPaymentMethodConfig() as never);

    const result = await settingsService.getPaymentMethodConfig('branch-1', OTHER_BRANCH_SUPERVISOR_ACTOR);

    expect(result?.cashEnabled).toBe(true);
  });

  it('rejects a supervisor requesting a branch that is not in the active-branch list with BRANCH_ACCESS_DENIED', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);

    await expect(settingsService.getPaymentMethodConfig('branch-2', SUPERVISOR_ACTOR)).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });
  });
});

describe('settingsService.updatePaymentMethodConfig', () => {
  it('upserts record', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue({ id: 'branch-1' } as never);
    vi.mocked(settingsRepository.findPaymentMethodConfig).mockResolvedValue(null);
    vi.mocked(settingsRepository.upsertPaymentMethodConfig).mockResolvedValue(
      buildPaymentMethodConfig({ gcashEnabled: false }) as never,
    );

    const result = await settingsService.updatePaymentMethodConfig('branch-1', { gcashEnabled: false }, ACTOR, null);

    expect(settingsRepository.upsertPaymentMethodConfig).toHaveBeenCalledWith('branch-1', { gcashEnabled: false }, 'admin-1');
    expect(result.gcashEnabled).toBe(false);
  });

  it('rejects disabling the last remaining enabled method (merged against current state)', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue({ id: 'branch-1' } as never);
    vi.mocked(settingsRepository.findPaymentMethodConfig).mockResolvedValue(
      buildPaymentMethodConfig({ cashEnabled: true, gcashEnabled: false }) as never,
    );

    await expect(settingsService.updatePaymentMethodConfig('branch-1', { cashEnabled: false }, ACTOR, null)).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_ALL_DISABLED',
      statusCode: 422,
    });
    expect(settingsRepository.upsertPaymentMethodConfig).not.toHaveBeenCalled();
  });

  it('rejects disabling both methods at once when no record exists yet', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue({ id: 'branch-1' } as never);
    vi.mocked(settingsRepository.findPaymentMethodConfig).mockResolvedValue(null);

    await expect(
      settingsService.updatePaymentMethodConfig('branch-1', { cashEnabled: false, gcashEnabled: false }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_ALL_DISABLED', statusCode: 422 });
  });

  it('requires branch to exist', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(null);

    await expect(
      settingsService.updatePaymentMethodConfig('missing-branch', { cashEnabled: false }, ACTOR, null),
    ).rejects.toThrow('Branch not found');
  });

  it('allows any supervisor when the branch is active, regardless of their JWT branch_ids', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue({ id: 'branch-1' } as never);
    vi.mocked(settingsRepository.findPaymentMethodConfig).mockResolvedValue(null);
    vi.mocked(settingsRepository.upsertPaymentMethodConfig).mockResolvedValue(buildPaymentMethodConfig() as never);

    await expect(
      settingsService.updatePaymentMethodConfig('branch-1', { cashEnabled: true, gcashEnabled: true }, OTHER_BRANCH_SUPERVISOR_ACTOR, null),
    ).resolves.toMatchObject({ branchId: 'branch-1' });
  });

  it('rejects a supervisor requesting a branch that is not in the active-branch list with BRANCH_ACCESS_DENIED', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue(['branch-1']);

    await expect(
      settingsService.updatePaymentMethodConfig('branch-2', { cashEnabled: false }, SUPERVISOR_ACTOR, null),
    ).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED', statusCode: 403 });
  });
});

// Task 209.xx — centrally configurable PWD/Senior Citizen/Employee/Promotional discount percentages.
describe('settingsService.getDiscountPolicy', () => {
  it('returns the pre-settings-model defaults (20%/20%/20%, all enabled) when no discount_policy row exists', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);

    const policy = await settingsService.getDiscountPolicy();

    expect(policy.pwd).toEqual({ percentage: 20, isEnabled: true });
    expect(policy.senior_citizen).toEqual({ percentage: 20, isEnabled: true });
    expect(policy.employee).toEqual({ percentage: 20, isEnabled: true });
    expect(policy.updatedAt).toBeNull();
    expect(policy.updatedBy).toBeNull();
  });

  it('returns the persisted value once a supervisor/admin has saved one', async () => {
    const savedAt = new Date('2026-08-01T00:00:00.000Z');
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({
      id: 'setting-1',
      key: 'discount_policy',
      value: {
        pwd: { percentage: 10, isEnabled: true },
        senior_citizen: { percentage: 15, isEnabled: true },
        employee: { percentage: 20, isEnabled: false },
        promotional: { percentage: 20, isEnabled: true },
      },
      description: null,
      updatedBy: 'supervisor-1',
      createdAt: savedAt,
      updatedAt: savedAt,
    } as never);

    const policy = await settingsService.getDiscountPolicy();

    expect(policy.pwd.percentage).toBe(10);
    expect(policy.senior_citizen.percentage).toBe(15);
    expect(policy.employee.isEnabled).toBe(false);
    expect(policy.updatedBy).toBe('supervisor-1');
    expect(policy.updatedAt).toBe(savedAt.toISOString());
  });
});

describe('settingsService.updateDiscountPolicy', () => {
  it('merges a partial update (only Employee provided) over the existing/default policy and records an audit log', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);
    vi.mocked(settingsRepository.upsertSystemSetting).mockResolvedValue({
      id: 'setting-1',
      key: 'discount_policy',
      value: {},
      description: null,
      updatedBy: 'admin-1',
      createdAt: new Date(),
      updatedAt: new Date('2026-08-13T00:00:00.000Z'),
    } as never);
    const { recordAuditLog } = await import('../../middleware/audit-log.js');

    const result = await settingsService.updateDiscountPolicy({ employee: { percentage: 10 } }, ACTOR, null);

    expect(result.employee).toEqual({ percentage: 10, isEnabled: true });
    // Untouched types keep their (default, since nothing was persisted yet) values — a partial PUT never resets what it didn't mention.
    expect(result.senior_citizen).toEqual({ percentage: 20, isEnabled: true });
    expect(result.statutoryTypes).toEqual(['pwd', 'senior_citizen']);
    expect(settingsRepository.upsertSystemSetting).toHaveBeenCalledWith(
      'discount_policy',
      expect.objectContaining({ employee: { percentage: 10, isEnabled: true } }),
      'admin-1',
      expect.any(String),
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DISCOUNT_POLICY_UPDATED',
        entityType: 'system_setting',
        entityId: 'discount_policy',
        actorId: 'admin-1',
        beforeState: expect.objectContaining({ employee: { percentage: 20, isEnabled: true } }),
        afterState: expect.objectContaining({ employee: { percentage: 10, isEnabled: true } }),
      }),
    );
  });

  it('a Supervisor may update the Employee rate (adminOrSupervisor is enforced at the router, not the service)', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);
    vi.mocked(settingsRepository.upsertSystemSetting).mockResolvedValue({
      id: 'setting-1',
      key: 'discount_policy',
      value: {},
      description: null,
      updatedBy: 'supervisor-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const result = await settingsService.updateDiscountPolicy({ employee: { percentage: 15 } }, SUPERVISOR_ACTOR, null);

    expect(result.employee.percentage).toBe(15);
  });

  it('P50: refuses any change to the statutory PWD/Senior Citizen rate or enabled state, for every role, and writes nothing', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);
    const { recordAuditLog } = await import('../../middleware/audit-log.js');
    vi.mocked(recordAuditLog).mockClear();
    vi.mocked(settingsRepository.upsertSystemSetting).mockClear();

    const attempts = [
      [ACTOR, { pwd: { percentage: 10 } }],
      [ACTOR, { senior_citizen: { percentage: 25 } }],
      [SUPERVISOR_ACTOR, { senior_citizen: { percentage: 15 } }],
      [SUPERVISOR_ACTOR, { pwd: { isEnabled: false } }],
    ] as const;
    for (const [actor, input] of attempts) {
      await expect(settingsService.updateDiscountPolicy(input, actor, null)).rejects.toMatchObject({ code: 'STATUTORY_DISCOUNT_LOCKED', statusCode: 422 });
    }
    expect(settingsRepository.upsertSystemSetting).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it('P50: re-sending the stored statutory rows (the editor sends every row) is accepted; a legacy non-statutory value may be kept or restored to 20%', async () => {
    const savedAt = new Date('2026-08-01T00:00:00.000Z');
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({
      id: 'setting-1', key: 'discount_policy', description: null, updatedBy: 'admin-1', createdAt: savedAt, updatedAt: savedAt,
      value: { pwd: { percentage: 10, isEnabled: true }, senior_citizen: { percentage: 20, isEnabled: true }, employee: { percentage: 20, isEnabled: true }, promotional: { percentage: 20, isEnabled: true } },
    } as never);
    vi.mocked(settingsRepository.upsertSystemSetting).mockResolvedValue({ updatedAt: new Date() } as never);

    await expect(
      settingsService.updateDiscountPolicy({ pwd: { percentage: 10, isEnabled: true }, senior_citizen: { percentage: 20, isEnabled: true }, employee: { percentage: 5 } }, ACTOR, null),
    ).resolves.toBeDefined();
    const restored = await settingsService.updateDiscountPolicy({ pwd: { percentage: 20 } }, ACTOR, null);
    expect(restored.pwd.percentage).toBe(20);
    await expect(settingsService.updateDiscountPolicy({ pwd: { percentage: 12 } }, ACTOR, null)).rejects.toMatchObject({ code: 'STATUTORY_DISCOUNT_LOCKED' });
  });

  it('P50: a save carrying a stale expectedUpdatedAt is refused with SETTINGS_CHANGED and writes nothing', async () => {
    const savedAt = new Date('2026-08-01T00:00:00.000Z');
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({
      id: 'setting-1', key: 'discount_policy', description: null, updatedBy: 'admin-2', createdAt: savedAt, updatedAt: savedAt,
      value: { pwd: { percentage: 20, isEnabled: true }, senior_citizen: { percentage: 20, isEnabled: true }, employee: { percentage: 30, isEnabled: true }, promotional: { percentage: 20, isEnabled: true } },
    } as never);
    vi.mocked(settingsRepository.writeSystemSettingIfUnchanged).mockClear();

    await expect(
      settingsService.updateDiscountPolicy({ employee: { percentage: 10 }, expectedUpdatedAt: '2026-07-01T00:00:00.000Z' }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'SETTINGS_CHANGED', statusCode: 409 });
    // The editor loaded a never-saved policy (null), but it has been saved since.
    await expect(settingsService.updateDiscountPolicy({ employee: { percentage: 10 }, expectedUpdatedAt: null }, ACTOR, null)).rejects.toMatchObject({ code: 'SETTINGS_CHANGED' });
    expect(settingsRepository.writeSystemSettingIfUnchanged).not.toHaveBeenCalled();
  });

  it('P50: a current expectedUpdatedAt goes through the compare-and-set write; losing that race is refused', async () => {
    const savedAt = new Date('2026-08-01T00:00:00.000Z');
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({
      id: 'setting-1', key: 'discount_policy', description: null, updatedBy: 'admin-2', createdAt: savedAt, updatedAt: savedAt,
      value: { pwd: { percentage: 20, isEnabled: true }, senior_citizen: { percentage: 20, isEnabled: true }, employee: { percentage: 30, isEnabled: true }, promotional: { percentage: 20, isEnabled: true } },
    } as never);
    const next = new Date('2026-08-02T00:00:00.000Z');
    vi.mocked(settingsRepository.writeSystemSettingIfUnchanged).mockResolvedValueOnce({ updatedAt: next } as never);

    const result = await settingsService.updateDiscountPolicy({ employee: { percentage: 10 }, expectedUpdatedAt: savedAt.toISOString() }, ACTOR, null);
    expect(result.updatedAt).toBe(next.toISOString());
    expect(settingsRepository.writeSystemSettingIfUnchanged).toHaveBeenCalledWith(
      'discount_policy',
      expect.objectContaining({ employee: { percentage: 10, isEnabled: true } }),
      'admin-1',
      savedAt,
      expect.any(String),
    );

    vi.mocked(settingsRepository.writeSystemSettingIfUnchanged).mockResolvedValueOnce(null);
    await expect(
      settingsService.updateDiscountPolicy({ employee: { percentage: 11 }, expectedUpdatedAt: savedAt.toISOString() }, ACTOR, null),
    ).rejects.toMatchObject({ code: 'SETTINGS_CHANGED' });
  });

  it('P50: getTaxConfiguration reports the statutory constants and current rates, and flags a legacy non-statutory PWD/Senior value', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);
    expect(await settingsService.getTaxConfiguration()).toEqual({
      vatRatePercent: 12,
      pricesIncludeVat: true,
      statutoryDiscountPercent: 20,
      vatExemptDiscountTypes: ['pwd', 'senior_citizen'],
      scope: 'organization',
      discountRates: { pwd: 20, senior_citizen: 20, employee: 20 },
      statutoryRateMismatch: false,
    });
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({
      id: 's', key: 'discount_policy', description: null, updatedBy: 'a', createdAt: new Date(), updatedAt: new Date(),
      value: { pwd: { percentage: 10, isEnabled: true }, senior_citizen: { percentage: 20, isEnabled: true }, employee: { percentage: 20, isEnabled: true }, promotional: { percentage: 20, isEnabled: true } },
    } as never);
    expect((await settingsService.getTaxConfiguration()).statutoryRateMismatch).toBe(true);
  });

  it('does not silently accept an out-of-range percentage — validation is the zod schema layer, exercised here directly', async () => {
    const { updateDiscountPolicySchema } = await import('@potato-corner/shared');

    expect(updateDiscountPolicySchema.safeParse({ pwd: { percentage: 150 } }).success).toBe(false);
    expect(updateDiscountPolicySchema.safeParse({ pwd: { percentage: -5 } }).success).toBe(false);
    expect(updateDiscountPolicySchema.safeParse({ pwd: { percentage: Number.NaN } }).success).toBe(false);
    expect(updateDiscountPolicySchema.safeParse({ pwd: { percentage: Number.POSITIVE_INFINITY } }).success).toBe(false);
    expect(updateDiscountPolicySchema.safeParse({}).success).toBe(false); // at least one type required
    expect(updateDiscountPolicySchema.safeParse({ pwd: { percentage: 10 } }).success).toBe(true);
  });
});

// P3D-P4 — Super Admin-configurable regular-shift length before overtime accrues.
describe('settingsService.getWorkHoursPolicy', () => {
  it('returns the pre-settings-model default (8h) when no work_hours_policy row exists', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);

    const policy = await settingsService.getWorkHoursPolicy();

    expect(policy.regularHours).toBe(8);
    expect(policy.updatedAt).toBeNull();
    expect(policy.updatedBy).toBeNull();
  });

  it('returns the persisted value once a Super Admin has saved one', async () => {
    const savedAt = new Date('2026-08-01T00:00:00.000Z');
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({
      id: 'setting-1',
      key: 'work_hours_policy',
      value: { regularHours: 9 },
      description: null,
      updatedBy: 'admin-1',
      createdAt: savedAt,
      updatedAt: savedAt,
    } as never);

    const policy = await settingsService.getWorkHoursPolicy();

    expect(policy.regularHours).toBe(9);
    expect(policy.updatedBy).toBe('admin-1');
    expect(policy.updatedAt).toBe(savedAt.toISOString());
  });
});

describe('settingsService.updateWorkHoursPolicy', () => {
  it('persists to SystemSetting table and records an audit log', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);
    vi.mocked(settingsRepository.upsertSystemSetting).mockResolvedValue({
      id: 'setting-1',
      key: 'work_hours_policy',
      value: { regularHours: 9 },
      description: null,
      updatedBy: 'admin-1',
      createdAt: new Date(),
      updatedAt: new Date('2026-08-13T00:00:00.000Z'),
    } as never);
    const { recordAuditLog } = await import('../../middleware/audit-log.js');

    const result = await settingsService.updateWorkHoursPolicy({ regularHours: 9 }, ACTOR, null);

    expect(result.regularHours).toBe(9);
    expect(settingsRepository.upsertSystemSetting).toHaveBeenCalledWith(
      'work_hours_policy',
      { regularHours: 9 },
      'admin-1',
      expect.any(String),
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WORK_HOURS_POLICY_UPDATED',
        entityType: 'system_setting',
        entityId: 'work_hours_policy',
        actorId: 'admin-1',
        beforeState: expect.objectContaining({ regularHours: 8 }),
        afterState: { regularHours: 9 },
      }),
    );
  });

  it('does not silently accept zero, negative, NaN, or absurd values — validation is the zod schema layer, exercised here directly', async () => {
    const { updateWorkHoursPolicySchema } = await import('@potato-corner/shared');

    expect(updateWorkHoursPolicySchema.safeParse({ regularHours: 0 }).success).toBe(false);
    expect(updateWorkHoursPolicySchema.safeParse({ regularHours: -1 }).success).toBe(false);
    expect(updateWorkHoursPolicySchema.safeParse({ regularHours: Number.NaN }).success).toBe(false);
    expect(updateWorkHoursPolicySchema.safeParse({ regularHours: 25 }).success).toBe(false);
    expect(updateWorkHoursPolicySchema.safeParse({}).success).toBe(false);
    expect(updateWorkHoursPolicySchema.safeParse({ regularHours: 8 }).success).toBe(true);
    expect(updateWorkHoursPolicySchema.safeParse({ regularHours: 7.5 }).success).toBe(true);
  });
});

describe('settingsService.getRegularShiftMinutes', () => {
  it('converts the default 8h policy to 480 minutes when no row exists', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);

    await expect(settingsService.getRegularShiftMinutes()).resolves.toBe(480);
  });

  it('converts a configured 9h policy to 540 minutes', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({
      id: 'setting-1',
      key: 'work_hours_policy',
      value: { regularHours: 9 },
      description: null,
      updatedBy: 'admin-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    await expect(settingsService.getRegularShiftMinutes()).resolves.toBe(540);
  });

  it('rounds a fractional-hour policy (7.5h) to whole minutes (450)', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({
      id: 'setting-1',
      key: 'work_hours_policy',
      value: { regularHours: 7.5 },
      description: null,
      updatedBy: 'admin-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    await expect(settingsService.getRegularShiftMinutes()).resolves.toBe(450);
  });
});

// POS-PERF-P16 — operational write gate (blocks checkout + inventory
// mutations during a free-plan maintenance/deploy window). Same SystemSetting
// KV pattern as work_hours_policy above.
describe('settingsService.getWriteGate', () => {
  it('defaults to open (enabled: false) when no operational_write_gate row exists', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);

    const state = await settingsService.getWriteGate();

    expect(state.enabled).toBe(false);
    expect(state.reason).toBeNull();
    expect(state.updatedAt).toBeNull();
    expect(state.updatedBy).toBeNull();
    expect(state.activeGatedRequests).toBe(0);
  });

  it('returns the persisted closed state once an admin has closed it', async () => {
    const closedAt = new Date('2026-10-06T00:00:00.000Z');
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({
      id: 'setting-1',
      key: 'operational_write_gate',
      value: { enabled: true, reason: 'Render deploy swap' },
      description: null,
      updatedBy: 'admin-1',
      createdAt: closedAt,
      updatedAt: closedAt,
    } as never);

    const state = await settingsService.getWriteGate();

    expect(state.enabled).toBe(true);
    expect(state.reason).toBe('Render deploy swap');
    expect(state.updatedBy).toBe('admin-1');
    expect(state.updatedAt).toBe(closedAt.toISOString());
  });
});

describe('settingsService.setWriteGate', () => {
  it('closing the gate persists {enabled:true, reason} and records an audit log', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);
    const { recordAuditLog } = await import('../../middleware/audit-log.js');

    await settingsService.setWriteGate({ enabled: true, reason: 'Render deploy swap' }, ACTOR, null);

    expect(settingsRepository.upsertSystemSetting).toHaveBeenCalledWith(
      'operational_write_gate',
      { enabled: true, reason: 'Render deploy swap' },
      'admin-1',
      expect.any(String),
    );
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WRITE_GATE_ENABLED',
        entityType: 'system_setting',
        entityId: 'operational_write_gate',
        actorId: 'admin-1',
        afterState: { enabled: true, reason: 'Render deploy swap' },
      }),
    );
  });

  it('reopening the gate persists {enabled:false, reason:null} and records an audit log, even with no reason given', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue({
      id: 'setting-1',
      key: 'operational_write_gate',
      value: { enabled: true, reason: 'Render deploy swap' },
      description: null,
      updatedBy: 'admin-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const { recordAuditLog } = await import('../../middleware/audit-log.js');

    await settingsService.setWriteGate({ enabled: false }, ACTOR, null);

    expect(settingsRepository.upsertSystemSetting).toHaveBeenCalledWith(
      'operational_write_gate',
      { enabled: false, reason: null },
      'admin-1',
      expect.any(String),
    );
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'WRITE_GATE_DISABLED' }));
  });

  it('rejects closing the gate with no reason — even if a caller bypassed the router-level schema check', async () => {
    vi.mocked(settingsRepository.findSystemSetting).mockResolvedValue(null);

    await expect(settingsService.setWriteGate({ enabled: true }, ACTOR, null)).rejects.toMatchObject({
      code: 'REASON_REQUIRED',
    });
    expect(settingsRepository.upsertSystemSetting).not.toHaveBeenCalled();
  });

  it('updateWriteGateSchema rejects enabled:true with no reason, and enabled:true with an empty-string reason', async () => {
    const { updateWriteGateSchema } = await import('@potato-corner/shared');

    expect(updateWriteGateSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(updateWriteGateSchema.safeParse({ enabled: true, reason: '' }).success).toBe(false);
    expect(updateWriteGateSchema.safeParse({ enabled: true, reason: 'ok' }).success).toBe(true);
    expect(updateWriteGateSchema.safeParse({ enabled: false }).success).toBe(true);
  });
});
