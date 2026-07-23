import type { SecurityPolicy } from '@potato-corner/shared';

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
