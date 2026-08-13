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

export const paymentMethodConfigSchema = z.object({
  cashEnabled: z.boolean(),
  gcashEnabled: z.boolean(),
});

/** Partial PUT — same precedent as updateReceiptConfigSchema: only the provided fields are changed. */
export const updatePaymentMethodConfigSchema = paymentMethodConfigSchema.partial();

export const paymentMethodConfigResponseSchema = paymentMethodConfigSchema.extend({
  branchId: z.uuid(),
  updatedAt: z.iso.datetime(),
});

/**
 * Task 209.xx — centrally configurable percentage for the four EXISTING POS
 * discount types (PWD, Senior Citizen, Employee, Promotional). Stored as
 * SystemSetting(key='discount_policy').value, same KV pattern as
 * securityPolicySchema above. This governs only the *rate* each type
 * applies — it does not add a new discount type or a new discount engine.
 * See transactions.service.ts computeAmounts for how PWD/Senior Citizen's
 * statutory VAT-exemption formula stays separate from this configurable
 * percentage.
 */
export const CONFIGURABLE_DISCOUNT_TYPES = ['pwd', 'senior_citizen', 'employee', 'promotional'] as const;
export type ConfigurableDiscountType = (typeof CONFIGURABLE_DISCOUNT_TYPES)[number];

const discountRateEntrySchema = z.object({
  percentage: z.number().finite().min(0).max(100),
  isEnabled: z.boolean(),
});

export const discountPolicySchema = z.object({
  pwd: discountRateEntrySchema,
  senior_citizen: discountRateEntrySchema,
  employee: discountRateEntrySchema,
  promotional: discountRateEntrySchema,
});

/** Partial per-type PUT — only the provided discount type(s) are changed, same precedent as updatePaymentMethodConfigSchema. */
export const updateDiscountPolicySchema = z
  .object({
    pwd: discountRateEntrySchema.partial().optional(),
    senior_citizen: discountRateEntrySchema.partial().optional(),
    employee: discountRateEntrySchema.partial().optional(),
    promotional: discountRateEntrySchema.partial().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one discount type must be provided' });

export const discountPolicyResponseSchema = discountPolicySchema.extend({
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
});
