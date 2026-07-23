import { z } from 'zod';

/**
 * Security policy — stored as SystemSetting(key='security_policy').value.
 * sessionTimeoutMinutes floor of 5 keeps an admin from locking themselves
 * (and everyone else) out with an unusably short session.
 */
export const securityPolicySchema = z.object({
  sessionTimeoutMinutes: z.number().int().min(5).max(1440),
  passwordMinLength: z.number().int().min(8).max(64),
  requirePasswordComplexity: z.boolean(),
  require2faForAdmins: z.boolean(),
  require2faForSupervisors: z.boolean(),
  maxFailedLoginAttempts: z.number().int().min(3).max(20),
  lockoutDurationMinutes: z.number().int().min(1).max(1440),
});

export const updateSecurityPolicySchema = securityPolicySchema;

const emailDigestFrequencyValues = ['daily', 'weekly', 'off'] as const;

export const notificationPreferencesSchema = z.object({
  emailDigestEnabled: z.boolean(),
  emailDigestFrequency: z.enum(emailDigestFrequencyValues),
  alertFraud: z.boolean(),
  alertLowStock: z.boolean(),
  alertCashVariance: z.boolean(),
  alertVoidRequests: z.boolean(),
  dndEnabled: z.boolean(),
  dndStartHour: z.number().int().min(0).max(23),
  dndEndHour: z.number().int().min(0).max(23),
});

/** All fields optional — PUT updates only the provided fields (partial update on top of the existing/default record). */
export const updateNotificationPreferencesSchema = notificationPreferencesSchema.partial();

export const receiptConfigSchema = z.object({
  headerText: z.string().max(500).nullable(),
  footerText: z.string().max(500).nullable(),
  showBranchLogo: z.boolean(),
});

export const updateReceiptConfigSchema = z.object({
  headerText: z.string().max(500).nullable().optional(),
  footerText: z.string().max(500).nullable().optional(),
  showBranchLogo: z.boolean().optional(),
});

export const receiptConfigResponseSchema = receiptConfigSchema.extend({
  branchId: z.uuid(),
  updatedAt: z.iso.datetime(),
});
