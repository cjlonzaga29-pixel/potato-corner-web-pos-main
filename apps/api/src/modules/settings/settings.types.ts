import type { SecurityPolicy, DiscountPolicy, ConfigurableDiscountType, WorkHoursPolicy } from '@potato-corner/shared';

/** Key of the single SystemSetting row that stores the security policy JSON blob. */
export const SECURITY_POLICY_KEY = 'security_policy';

/**
 * Fallback used when no `security_policy` SystemSetting row exists yet
 * (fresh install, or before any admin has saved changes).
 */
export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  sessionTimeoutMinutes: 60,
  passwordMinLength: 8,
  requirePasswordComplexity: true,
  require2faForAdmins: false,
  require2faForSupervisors: false,
  maxFailedLoginAttempts: 5,
  lockoutDurationMinutes: 30,
};

export interface UpdateNotificationPreferenceData {
  emailDigestEnabled?: boolean;
  emailDigestFrequency?: string;
  alertFraud?: boolean;
  alertLowStock?: boolean;
  alertCashVariance?: boolean;
  alertVoidRequests?: boolean;
  dndEnabled?: boolean;
  dndStartHour?: number;
  dndEndHour?: number;
}

export interface UpdateBranchReceiptConfigData {
  headerText?: string | null;
  footerText?: string | null;
  showBranchLogo?: boolean;
}

export interface UpdateBranchPaymentMethodConfigData {
  cashEnabled?: boolean;
  gcashEnabled?: boolean;
}

/** Key of the single SystemSetting row that stores the discount policy JSON blob. */
export const DISCOUNT_POLICY_KEY = 'discount_policy';

/**
 * Fallback used when no `discount_policy` SystemSetting row exists yet.
 * pwd/senior_citizen/employee mirror the STATUTORY_DISCOUNT_RATE/
 * EMPLOYEE_DISCOUNT_RATE constants transactions.service.ts hardcoded before
 * this settings model existed (both 20%) — this is the exact value already
 * live in production, not a new default. Promotional has no prior hardcoded
 * rate (checkout still rejects DISCOUNT_TYPE_NOT_SUPPORTED for it — see
 * transactions.service.ts createTransaction; this settings row does not
 * change that), so 20%/enabled is a placeholder a supervisor can configure
 * ahead of that feature shipping, not a value anything reads today.
 */
export const DEFAULT_DISCOUNT_POLICY: DiscountPolicy = {
  pwd: { percentage: 20, isEnabled: true },
  senior_citizen: { percentage: 20, isEnabled: true },
  employee: { percentage: 20, isEnabled: true },
  promotional: { percentage: 20, isEnabled: true },
};

export type UpdateDiscountPolicyData = Partial<Record<ConfigurableDiscountType, { percentage?: number; isEnabled?: boolean }>>;

/** Key of the single SystemSetting row that stores the regular-work-hours policy JSON blob (P3D-P4). */
export const WORK_HOURS_POLICY_KEY = 'work_hours_policy';

/**
 * Fallback used when no `work_hours_policy` SystemSetting row exists yet —
 * mirrors the STANDARD_SHIFT_MINUTES = 8 * 60 constant attendance.service.ts
 * hardcoded before this setting existed, so an absent row preserves current
 * production behavior exactly.
 */
export const DEFAULT_WORK_HOURS_POLICY: WorkHoursPolicy = {
  regularHours: 8,
};

/** Key of the single SystemSetting row that stores the operational write-gate state (POS-PERF-P16). */
export const WRITE_GATE_KEY = 'operational_write_gate';

export interface WriteGateStateValue {
  enabled: boolean;
  reason: string | null;
}

/** Fallback used when no `operational_write_gate` SystemSetting row exists yet — gate open, same as every pre-P16 deployment's actual behavior. */
export const DEFAULT_WRITE_GATE_STATE: WriteGateStateValue = { enabled: false, reason: null };

/** Mirrors auth.types.ts's AuthError / employees.types.ts's EmployeeError — this module's own domain error → HTTP status mapping. */
export class SettingsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}
