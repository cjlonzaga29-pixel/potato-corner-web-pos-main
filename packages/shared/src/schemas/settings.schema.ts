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

/**
 * Partial per-type PUT — only the provided discount type(s) are changed, same precedent as updatePaymentMethodConfigSchema.
 *
 * POS-PERF-P50 — expectedUpdatedAt is the `updatedAt` the editor loaded
 * (null when the policy had never been saved). When present, the server
 * refuses the save with 409 SETTINGS_CHANGED if someone else saved in
 * between, instead of silently overwriting their change. Optional only so
 * an older web build can still save during a rollout.
 */
export const updateDiscountPolicySchema = z
  .object({
    pwd: discountRateEntrySchema.partial().optional(),
    senior_citizen: discountRateEntrySchema.partial().optional(),
    employee: discountRateEntrySchema.partial().optional(),
    promotional: discountRateEntrySchema.partial().optional(),
    expectedUpdatedAt: z.iso.datetime().nullable().optional(),
  })
  .refine((data) => CONFIGURABLE_DISCOUNT_TYPES.some((type) => data[type] !== undefined), {
    message: 'At least one discount type must be provided',
  });

export const discountPolicyResponseSchema = discountPolicySchema.extend({
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
  /** POS-PERF-P50 — types whose rate/enabled state is fixed by law and refused on update (absent from older APIs). */
  statutoryTypes: z.array(z.enum(CONFIGURABLE_DISCOUNT_TYPES)).optional(),
  /**
   * POS-PERF-P50R — present when this is one branch's effective policy (a
   * staff/branch caller always gets its own branch's; others pass
   * ?branch_id=). Absent = the organization default.
   */
  branchId: z.uuid().optional(),
  /** POS-PERF-P50R — the cashier must pick a discount or "No applicable discount" before charging (branch setting). */
  requireDiscountChoice: z.boolean().optional(),
});

/**
 * POS-PERF-P50R — one branch's discount override. Every field is optional
 * in the stored row; null means "use the organization default". Bounds:
 * Employee 0–100 (business choice); PWD at least the statutory 20%
 * (RA 10754 §1: "at least twenty percent"), never disabled. Senior Citizen is
 * not here: RA 9994 §4(a) grants exactly 20%, so it is not branch-editable.
 */
export const PWD_MAX_PERCENT = 100;

export const branchDiscountOverrideSchema = z.object({
  employee: discountRateEntrySchema.nullable(),
  pwdPercentage: z.number().finite().min(20).max(PWD_MAX_PERCENT).nullable(),
  requireDiscountChoice: z.boolean(),
});

/** PUT /api/settings/discounts/branches/:branchId — the full override (no partial merge) plus the stale-save token. */
export const updateBranchDiscountSettingsSchema = branchDiscountOverrideSchema.extend({
  /** The branch row's `updatedAt` the editor loaded, null = it had no override. Required: no last-write-wins path. */
  expectedUpdatedAt: z.iso.datetime().nullable(),
});

export const DISCOUNT_SETTING_SOURCES = ['statute', 'organization', 'branch'] as const;
export type DiscountSettingSource = (typeof DISCOUNT_SETTING_SOURCES)[number];

const effectiveRateSchema = z.object({
  percentage: z.number(),
  isEnabled: z.boolean(),
  source: z.enum(DISCOUNT_SETTING_SOURCES),
});

/**
 * POS-PERF-P50R — VAT registration is a legal fact about the seller, not a
 * tax toggle. 'unconfirmed' (the default for every existing branch) keeps
 * the pre-P50R calculation (VAT-registered) and says so visibly.
 * 'non_vat_registered' is listed so the editor can explain it, but this
 * release refuses it: a non-VAT seller needs a different receipt and
 * calculation that is not built (runbook D1).
 */
export const VAT_REGISTRATION_STATUSES = ['unconfirmed', 'vat_registered', 'non_vat_registered'] as const;
export type VatRegistrationStatus = (typeof VAT_REGISTRATION_STATUSES)[number];
export const SUPPORTED_VAT_REGISTRATION_STATUSES: readonly VatRegistrationStatus[] = ['unconfirmed', 'vat_registered'];

export const branchTaxProfileSchema = z.object({
  vatRegistration: z.enum(VAT_REGISTRATION_STATUSES),
  /** Free-text note on where the registration was confirmed (e.g. "BIR COR 2303 seen 2026-10-30"). */
  note: z.string().trim().max(300).nullable(),
});

/** PUT /api/settings/tax/branches/:branchId — Super Admin only. */
export const updateBranchTaxProfileSchema = branchTaxProfileSchema.extend({
  expectedUpdatedAt: z.iso.datetime().nullable(),
});

export const branchTaxProfileResponseSchema = branchTaxProfileSchema.extend({
  branchId: z.uuid(),
  /** How checkout actually calculates for this branch. Always 'vat_registered' in this release. */
  calculatedAs: z.literal('vat_registered'),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
});

/** GET /api/settings/discounts/branches/:branchId — defaults, override, effective values and who may change what. */
export const branchDiscountSettingsResponseSchema = z.object({
  branchId: z.uuid(),
  branchName: z.string(),
  organization: z.object({
    pwd: discountRateEntrySchema,
    senior_citizen: discountRateEntrySchema,
    employee: discountRateEntrySchema,
    updatedAt: z.iso.datetime().nullable(),
  }),
  override: branchDiscountOverrideSchema.nullable(),
  effective: z.object({
    pwd: effectiveRateSchema,
    senior_citizen: effectiveRateSchema,
    employee: effectiveRateSchema,
    requireDiscountChoice: z.boolean(),
  }),
  taxProfile: branchTaxProfileResponseSchema,
  /** The override row's updatedAt (null = no override yet) — send back as expectedUpdatedAt. */
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
  canEdit: z.boolean(),
  canEditTaxProfile: z.boolean(),
});

/**
 * POS-PERF-P50 — GET /api/settings/tax: the tax configuration checkout is
 * using right now. The VAT rate, VAT-inclusive pricing and the exempt
 * treatment are statutory or fixed application behavior, not settings.
 * POS-PERF-P50R — with ?branch_id= (or for a staff/branch caller) the
 * branch's effective discount rates and its VAT registration status.
 */
export const taxConfigurationResponseSchema = z.object({
  vatRatePercent: z.number(),
  pricesIncludeVat: z.boolean(),
  statutoryDiscountPercent: z.number(),
  vatExemptDiscountTypes: z.array(z.string()),
  scope: z.enum(['organization', 'branch']),
  /** The discount rates checkout applies now (from Discount Settings). */
  discountRates: z.object({ pwd: z.number(), senior_citizen: z.number(), employee: z.number() }),
  /** True when a stored Senior rate is not 20% or a PWD rate is below 20%/disabled (only possible for data saved before P50). */
  statutoryRateMismatch: z.boolean(),
  branchId: z.uuid().optional(),
  vatRegistration: z.enum(VAT_REGISTRATION_STATUSES).optional(),
});

/**
 * P3D-P4 — Super Admin-configurable regular-shift length before overtime
 * accrues. Stored as SystemSetting(key='work_hours_policy').value, same KV
 * pattern as securityPolicySchema/discountPolicySchema above. The Admin-
 * facing unit is HOURS; attendance.service.ts converts to minutes and is the
 * only place that reads this for the canonical regular/overtime split.
 * Bounds (1-24) block zero/negative/absurd values without pretending every
 * value in range is realistic — that judgment stays with the Super Admin.
 */
export const workHoursPolicySchema = z.object({
  regularHours: z.number().finite().min(1).max(24),
});

export const updateWorkHoursPolicySchema = workHoursPolicySchema;

export const workHoursPolicyResponseSchema = workHoursPolicySchema.extend({
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
});

/**
 * POS-PERF-P40 — additive per-branch override of the global policy above,
 * managed by that branch's supervisors. Stored as its own SystemSetting row
 * (key `work_hours_policy:branch:<branchId>`); with no row the branch keeps
 * using the global value. Only clock-outs and corrections saved after a
 * change use the new value — overtime is stored on each attendance record
 * when it is computed, so existing records are never recalculated.
 */
export const updateBranchWorkHoursSchema = workHoursPolicySchema;

export const branchWorkHoursResponseSchema = z.object({
  branchId: z.uuid(),
  branchName: z.string().nullable(),
  /** The value clock-out uses for this branch right now. */
  regularHours: z.number(),
  source: z.enum(['branch', 'global']),
  overrideHours: z.number().nullable(),
  globalHours: z.number(),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
});

/**
 * POS-PERF-P16 — operational write gate. Stored as
 * SystemSetting(key='operational_write_gate').value, same KV pattern as the
 * other policies above. When `enabled`, the server rejects checkout and
 * every inventory-mutating write with a 503 (see middleware/write-gate.ts)
 * so a free-tier Render deploy swap or rollback never lets two incompatible
 * application versions write stock/sales data at the same time. `reason` is
 * required when enabling (surfaced in the 503 body and the audit log) —
 * optional when disabling, since reopening traffic needs no justification
 * beyond "maintenance is over".
 */
export const updateWriteGateSchema = z
  .object({
    enabled: z.boolean(),
    reason: z.string().min(1).max(500).optional(),
  })
  .refine((data) => !data.enabled || Boolean(data.reason), {
    message: 'A reason is required when closing the write gate',
    path: ['reason'],
  });

export const writeGateResponseSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
  /** This process's own count of requests currently inside a gated route — see middleware/write-gate.ts. Per-instance, not cluster-wide; used to verify an HTTP drain before a deploy swap/rollback. */
  activeGatedRequests: z.number().int().min(0),
});
