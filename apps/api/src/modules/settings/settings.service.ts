import {
  type JwtPayload,
  type NotificationPreferences,
  type PaymentMethodConfigResponse,
  type ReceiptConfigResponse,
  type SecurityPolicy,
  type DiscountPolicy,
  type DiscountPolicyResponse,
  type WorkHoursPolicyResponse,
  type BranchWorkHoursResponse,
  type UpdateBranchWorkHoursInput,
  type WriteGateResponse,
  type UpdateNotificationPreferencesInput,
  type UpdatePaymentMethodConfigInput,
  type UpdateReceiptConfigInput,
  type UpdateSecurityPolicyInput,
  type UpdateDiscountPolicyInput,
  type UpdateWorkHoursPolicyInput,
  type UpdateWriteGateInput,
  type TaxConfigurationResponse,
  type ConfigurableDiscountType,
  type BranchDiscountOverride,
  type BranchDiscountSettingsResponse,
  type BranchTaxProfileResponse,
  type UpdateBranchDiscountSettingsInput,
  type UpdateBranchTaxProfileInput,
  type DiscountSettingSource,
  type VatRegistrationStatus,
  CONFIGURABLE_DISCOUNT_TYPES,
  ROLES,
  SUPPORTED_VAT_REGISTRATION_STATUSES,
  isLawfulPwdRate,
  isLawfulSeniorRate,
  PRICES_INCLUDE_VAT,
  STATUTORY_DISCOUNT_PERCENT,
  VAT_EXEMPT_DISCOUNT_TYPES,
  VAT_RATE_PERCENT,
} from '@potato-corner/shared';
import type {
  NotificationPreference as NotificationPreferenceRow,
  BranchReceiptConfig as BranchReceiptConfigRow,
  BranchPaymentMethodConfig as BranchPaymentMethodConfigRow,
  Prisma,
} from '@prisma/client';
import { settingsRepository } from './settings.repository.js';
import {
  DEFAULT_SECURITY_POLICY,
  SECURITY_POLICY_KEY,
  DEFAULT_DISCOUNT_POLICY,
  DISCOUNT_POLICY_KEY,
  DEFAULT_WORK_HOURS_POLICY,
  WORK_HOURS_POLICY_KEY,
  BRANCH_WORK_HOURS_KEY_PREFIX,
  branchWorkHoursKey,
  WRITE_GATE_KEY,
  branchDiscountKey,
  branchTaxProfileKey,
  resolveWriteGateState,
  type WriteGateStateValue,
  SettingsError,
} from './settings.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { getActiveGatedRequestCount } from '../../middleware/write-gate.js';
import { branchesRepository } from '../branches/branches.repository.js';
import { assertBranchAccess as sharedAssertBranchAccess } from '../../lib/branch-access.js';

type ActorContext = JwtPayload;

function toNotificationPreferencesResponse(row: NotificationPreferenceRow): NotificationPreferences {
  return {
    emailDigestEnabled: row.emailDigestEnabled,
    emailDigestFrequency: row.emailDigestFrequency as NotificationPreferences['emailDigestFrequency'],
    alertFraud: row.alertFraud,
    alertLowStock: row.alertLowStock,
    alertCashVariance: row.alertCashVariance,
    alertVoidRequests: row.alertVoidRequests,
    dndEnabled: row.dndEnabled,
    dndStartHour: row.dndStartHour,
    dndEndHour: row.dndEndHour,
  };
}

function toReceiptConfigResponse(row: BranchReceiptConfigRow): ReceiptConfigResponse {
  return {
    branchId: row.branchId,
    headerText: row.headerText,
    footerText: row.footerText,
    showBranchLogo: row.showBranchLogo,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPaymentMethodConfigResponse(row: BranchPaymentMethodConfigRow): PaymentMethodConfigResponse {
  return {
    branchId: row.branchId,
    cashEnabled: row.cashEnabled,
    gcashEnabled: row.gcashEnabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * POS-PERF-P50 — PWD (RA 10754) and Senior Citizen (RA 9994) discounts are
 * required by law with VAT exemption: no role may disable them or set them
 * below the statute. Re-sending the value already stored is accepted (the
 * editor sends every row), so a policy saved before P50 can still be saved
 * around.
 *
 * POS-PERF-P50R — RA 10754 §1 grants PWDs "at least twenty percent", so a
 * PWD rate from 20% to 100% is accepted (a lawful enhancement). RA 9994
 * §4(a) grants seniors "twenty percent (20%)", so Senior stays exactly 20%.
 */
const STATUTORY_DISCOUNT_TYPES: readonly ConfigurableDiscountType[] = ['pwd', 'senior_citizen'];

function assertStatutoryRowsUnchanged(data: UpdateDiscountPolicyInput, before: DiscountPolicy): void {
  for (const type of STATUTORY_DISCOUNT_TYPES) {
    const incoming = data[type];
    if (!incoming) continue;
    const lawful = type === 'pwd' ? isLawfulPwdRate : isLawfulSeniorRate;
    const percentageOk = incoming.percentage === undefined || lawful(incoming.percentage) || incoming.percentage === before[type].percentage;
    const enabledOk = incoming.isEnabled === undefined || incoming.isEnabled || incoming.isEnabled === before[type].isEnabled;
    if (!percentageOk || !enabledOk) {
      throw new SettingsError(
        'STATUTORY_DISCOUNT_LOCKED',
        type === 'pwd'
          ? `The PWD discount is required by law (RA 10754): at least ${STATUTORY_DISCOUNT_PERCENT}%, VAT-exempt. It can be raised up to 100% but not lowered below ${STATUTORY_DISCOUNT_PERCENT}% or turned off.`
          : `The Senior Citizen discount is set by law (RA 9994): exactly ${STATUTORY_DISCOUNT_PERCENT}%, VAT-exempt. It cannot be changed or turned off.`,
        422,
      );
    }
  }
}

/** True when stored data (only possible before P50) puts a statutory row outside the law. */
function statutoryRowsOffStatute(policy: Pick<DiscountPolicy, 'pwd' | 'senior_citizen'>): boolean {
  return (
    !isLawfulPwdRate(policy.pwd.percentage) ||
    !policy.pwd.isEnabled ||
    !isLawfulSeniorRate(policy.senior_citizen.percentage) ||
    !policy.senior_citizen.isEnabled
  );
}

/** POS-PERF-P50R — one branch's discount values as checkout applies them, with where each came from. */
export interface EffectiveDiscountPolicy {
  branchId: string;
  organization: DiscountPolicyResponse;
  override: BranchDiscountOverride | null;
  overrideUpdatedAt: string | null;
  overrideUpdatedBy: string | null;
  policy: DiscountPolicy;
  sources: Record<'pwd' | 'senior_citizen' | 'employee', DiscountSettingSource>;
  requireDiscountChoice: boolean;
  vatRegistration: 'unconfirmed' | 'vat_registered';
}

type SettingRow = { value: unknown; updatedAt: Date; updatedBy: string };

function readOverride(value: unknown): BranchDiscountOverride | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<BranchDiscountOverride>;
  const employee =
    v.employee && typeof v.employee.percentage === 'number' && typeof v.employee.isEnabled === 'boolean'
      ? { percentage: v.employee.percentage, isEnabled: v.employee.isEnabled }
      : null;
  // Defensive: a stored PWD rate below the statute is ignored, never applied.
  const pwdPercentage = typeof v.pwdPercentage === 'number' && isLawfulPwdRate(v.pwdPercentage) ? v.pwdPercentage : null;
  return { employee, pwdPercentage, requireDiscountChoice: v.requireDiscountChoice === true };
}

function readTaxProfile(branchId: string, row: SettingRow | undefined | null): BranchTaxProfileResponse {
  const value = (row?.value ?? {}) as { vatRegistration?: unknown; note?: unknown };
  const status: 'unconfirmed' | 'vat_registered' = value.vatRegistration === 'vat_registered' ? 'vat_registered' : 'unconfirmed';
  return {
    branchId,
    vatRegistration: status,
    note: typeof value.note === 'string' ? value.note : null,
    calculatedAs: 'vat_registered',
    updatedAt: row ? row.updatedAt.toISOString() : null,
    updatedBy: row ? row.updatedBy : null,
  };
}

function toOrganizationResponse(row: SettingRow | undefined | null): DiscountPolicyResponse {
  if (!row) return { ...DEFAULT_DISCOUNT_POLICY, updatedAt: null, updatedBy: null, statutoryTypes: [...STATUTORY_DISCOUNT_TYPES] };
  const value = row.value as unknown as DiscountPolicy;
  return { ...value, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy, statutoryTypes: [...STATUTORY_DISCOUNT_TYPES] };
}

/** Staff and Branch Accounts are bound to one branch; their reads are always scoped to it. */
function branchBoundId(actor: ActorContext): string | null {
  return actor.role === ROLES.STAFF || actor.role === ROLES.BRANCH ? (actor.branch_ids[0] ?? null) : null;
}

const ORGANIZATION_ADMIN_ONLY_MESSAGE =
  'Organization-wide discount defaults are set by a Super Admin. Supervisors change discounts for their own branches in Settings → Discounts & VAT.';

/** Default state assumed when no BranchPaymentMethodConfig row exists yet (both methods enabled). */
const DEFAULT_PAYMENT_METHOD_CONFIG = { cashEnabled: true, gcashEnabled: true };

/** Throws BRANCH_ACCESS_DENIED unless the actor is a Super Admin, a Supervisor (any active branch), or is assigned to this branch. */
async function assertBranchAccess(branchId: string, actor: ActorContext): Promise<void> {
  await sharedAssertBranchAccess(actor, branchId, SettingsError);
}

export const settingsService = {
  async getSecurityPolicy(): Promise<SecurityPolicy> {
    const setting = await settingsRepository.findSystemSetting(SECURITY_POLICY_KEY);
    if (!setting) return DEFAULT_SECURITY_POLICY;
    return setting.value as unknown as SecurityPolicy;
  },

  async updateSecurityPolicy(
    data: UpdateSecurityPolicyInput,
    updatedBy: ActorContext,
    ipAddress: string | null,
  ): Promise<SecurityPolicy> {
    const before = await settingsService.getSecurityPolicy();

    await settingsRepository.upsertSystemSetting(
      SECURITY_POLICY_KEY,
      data as unknown as Prisma.InputJsonValue,
      updatedBy.user_id,
      'Security policy configuration',
    );

    await recordAuditLog({
      action: 'SECURITY_POLICY_UPDATED',
      entityType: 'system_setting',
      entityId: SECURITY_POLICY_KEY,
      actorId: updatedBy.user_id,
      actorRole: updatedBy.role,
      beforeState: before,
      afterState: data,
      ipAddress,
    });

    return data;
  },

  async getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
    const existing = await settingsRepository.findNotificationPreference(userId);
    if (existing) return toNotificationPreferencesResponse(existing);

    const created = await settingsRepository.createDefaultNotificationPreference(userId);
    return toNotificationPreferencesResponse(created);
  },

  async updateNotificationPreferences(
    userId: string,
    data: UpdateNotificationPreferencesInput,
    updatedBy: ActorContext,
    ipAddress: string | null,
  ): Promise<NotificationPreferences> {
    const existing = await settingsRepository.findNotificationPreference(userId);
    if (!existing) await settingsRepository.createDefaultNotificationPreference(userId);

    const updated = await settingsRepository.updateNotificationPreference(userId, data);

    await recordAuditLog({
      action: 'NOTIFICATION_PREFERENCES_UPDATED',
      entityType: 'notification_preference',
      entityId: userId,
      actorId: updatedBy.user_id,
      actorRole: updatedBy.role,
      beforeState: existing ? toNotificationPreferencesResponse(existing) : null,
      afterState: data,
      ipAddress,
    });

    return toNotificationPreferencesResponse(updated);
  },

  async getBranchReceiptConfig(branchId: string): Promise<ReceiptConfigResponse | null> {
    const config = await settingsRepository.findBranchReceiptConfig(branchId);
    return config ? toReceiptConfigResponse(config) : null;
  },

  async updateBranchReceiptConfig(
    branchId: string,
    data: UpdateReceiptConfigInput,
    updatedBy: ActorContext,
    ipAddress: string | null,
  ): Promise<ReceiptConfigResponse> {
    // CR-003: router now admits supervisor/branch alongside super_admin
    // (adminSupervisorOrBranch) — this had no branch-ownership check at all
    // pre-CR-003 because only super_admin could ever reach it. Same guard
    // as updatePaymentMethodConfig below.
    await assertBranchAccess(branchId, updatedBy);

    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new SettingsError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    const before = await settingsRepository.findBranchReceiptConfig(branchId);

    const updated = await settingsRepository.upsertBranchReceiptConfig(branchId, data, updatedBy.user_id);

    await recordAuditLog({
      action: 'RECEIPT_CONFIG_UPDATED',
      entityType: 'branch_receipt_config',
      entityId: branchId,
      actorId: updatedBy.user_id,
      actorRole: updatedBy.role,
      branchId,
      beforeState: before ? toReceiptConfigResponse(before) : null,
      afterState: data,
      ipAddress,
    });

    return toReceiptConfigResponse(updated);
  },

  async getPaymentMethodConfig(branchId: string, actor: ActorContext): Promise<PaymentMethodConfigResponse | null> {
    await assertBranchAccess(branchId, actor);

    const config = await settingsRepository.findPaymentMethodConfig(branchId);
    return config ? toPaymentMethodConfigResponse(config) : null;
  },

  async updatePaymentMethodConfig(
    branchId: string,
    data: UpdatePaymentMethodConfigInput,
    actor: ActorContext,
    ipAddress: string | null,
  ): Promise<PaymentMethodConfigResponse> {
    await assertBranchAccess(branchId, actor);

    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new SettingsError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    const before = await settingsRepository.findPaymentMethodConfig(branchId);

    // Partial PUT — merge the incoming partial data over the currently persisted (or default) state
    // before validating the "at least one enabled" business rule, since only one field may be sent.
    const currentState = before
      ? { cashEnabled: before.cashEnabled, gcashEnabled: before.gcashEnabled }
      : DEFAULT_PAYMENT_METHOD_CONFIG;
    const merged = { ...currentState, ...data };

    if (!merged.cashEnabled && !merged.gcashEnabled) {
      throw new SettingsError('PAYMENT_METHOD_ALL_DISABLED', 'At least one payment method must remain enabled', 422);
    }

    const updated = await settingsRepository.upsertPaymentMethodConfig(branchId, data, actor.user_id);

    await recordAuditLog({
      action: 'PAYMENT_METHOD_CONFIG_UPDATED',
      entityType: 'branch_payment_method_config',
      entityId: branchId,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId,
      beforeState: before ? toPaymentMethodConfigResponse(before) : null,
      afterState: data,
      ipAddress,
    });

    return toPaymentMethodConfigResponse(updated);
  },

  /**
   * Task 209.xx — the single source of truth POS checkout, receipts, and
   * reports all resolve the current PWD/Senior Citizen/Employee/Promotional
   * percentage from. Falls back to DEFAULT_DISCOUNT_POLICY (the values
   * already hardcoded in transactions.service.ts before this settings model
   * existed) until a supervisor/admin saves a change for the first time.
   */
  async getDiscountPolicy(): Promise<DiscountPolicyResponse> {
    return toOrganizationResponse(await settingsRepository.findSystemSetting(DISCOUNT_POLICY_KEY));
  },

  /**
   * POS-PERF-P50R — the discount values checkout applies at one branch: the
   * organization default with the branch's override (if any) on top, read
   * in one round trip together with the branch's VAT registration. Senior
   * Citizen is never overridable; PWD may only be raised.
   */
  async getEffectiveDiscountPolicy(branchId: string): Promise<EffectiveDiscountPolicy> {
    const rows = await settingsRepository.findSystemSettings([DISCOUNT_POLICY_KEY, branchDiscountKey(branchId), branchTaxProfileKey(branchId)]);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const organization = toOrganizationResponse(byKey.get(DISCOUNT_POLICY_KEY));
    const overrideRow = byKey.get(branchDiscountKey(branchId));
    const override = overrideRow ? readOverride(overrideRow.value) : null;
    const branchPwd = override?.pwdPercentage ?? null;
    const branchEmployee = override?.employee ?? null;
    const policy: DiscountPolicy = {
      pwd: { percentage: branchPwd ?? organization.pwd.percentage, isEnabled: organization.pwd.isEnabled },
      senior_citizen: { ...organization.senior_citizen },
      employee: branchEmployee ? { ...branchEmployee } : { ...organization.employee },
      promotional: { ...organization.promotional },
    };
    return {
      branchId,
      organization,
      override,
      overrideUpdatedAt: overrideRow ? overrideRow.updatedAt.toISOString() : null,
      overrideUpdatedBy: overrideRow ? overrideRow.updatedBy : null,
      policy,
      sources: {
        pwd: branchPwd !== null ? 'branch' : policy.pwd.percentage === STATUTORY_DISCOUNT_PERCENT ? 'statute' : 'organization',
        senior_citizen: isLawfulSeniorRate(policy.senior_citizen.percentage) ? 'statute' : 'organization',
        employee: branchEmployee ? 'branch' : 'organization',
      },
      requireDiscountChoice: override?.requireDiscountChoice ?? false,
      vatRegistration: readTaxProfile(branchId, byKey.get(branchTaxProfileKey(branchId))).vatRegistration === 'vat_registered' ? 'vat_registered' : 'unconfirmed',
    };
  },

  /**
   * GET /discount-policy. A staff/branch caller always gets its own branch's
   * effective policy — so a POS built before P50R, which reads this route,
   * previews the rate its branch is actually charged. A supervisor/admin
   * gets the organization default, or one branch's effective policy with
   * ?branch_id= (access re-checked).
   */
  async getDiscountPolicyFor(actor: ActorContext, branchId: string | undefined): Promise<DiscountPolicyResponse> {
    const scoped = branchBoundId(actor) ?? branchId ?? null;
    if (!scoped) return settingsService.getDiscountPolicy();
    await assertBranchAccess(scoped, actor);
    const effective = await settingsService.getEffectiveDiscountPolicy(scoped);
    return {
      ...effective.policy,
      updatedAt: effective.overrideUpdatedAt ?? effective.organization.updatedAt,
      updatedBy: effective.overrideUpdatedBy ?? effective.organization.updatedBy,
      statutoryTypes: [...STATUTORY_DISCOUNT_TYPES],
      branchId: scoped,
      requireDiscountChoice: effective.requireDiscountChoice,
    };
  },

  async updateDiscountPolicy(
    data: UpdateDiscountPolicyInput,
    updatedBy: ActorContext,
    ipAddress: string | null,
  ): Promise<DiscountPolicyResponse> {
    // POS-PERF-P50R — a supervisor's save here used to change every branch.
    // Supervisors now change only their own branches (updateBranchDiscountSettings).
    if (updatedBy.role !== ROLES.SUPER_ADMIN) throw new SettingsError('ORGANIZATION_DISCOUNTS_ADMIN_ONLY', ORGANIZATION_ADMIN_ONLY_MESSAGE, 403);
    const before = await settingsService.getDiscountPolicy();
    assertStatutoryRowsUnchanged(data, before);

    // Partial per-type PUT — merge the incoming partial entries over the
    // currently persisted (or default) policy, same precedent as
    // updatePaymentMethodConfig's merge-then-validate.
    const merged: DiscountPolicy = { ...DEFAULT_DISCOUNT_POLICY };
    for (const type of CONFIGURABLE_DISCOUNT_TYPES) {
      merged[type] = { ...before[type], ...data[type] };
    }

    const description = 'Configurable POS discount percentages (PWD, Senior Citizen, Employee, Promotional)';
    let saved: { updatedAt: Date } | null;
    if (data.expectedUpdatedAt === undefined) {
      // Older web build (no stale token): last write wins, the pre-P50 behavior.
      saved = await settingsRepository.upsertSystemSetting(DISCOUNT_POLICY_KEY, merged as unknown as Prisma.InputJsonValue, updatedBy.user_id, description);
    } else {
      // POS-PERF-P50 — refuse instead of overwriting a newer save. The merge
      // above read `before`; the conditional write proves nothing changed since.
      const expected = data.expectedUpdatedAt === null ? null : new Date(data.expectedUpdatedAt);
      const stale = (expected?.toISOString() ?? null) !== before.updatedAt;
      saved = stale
        ? null
        : await settingsRepository.writeSystemSettingIfUnchanged(DISCOUNT_POLICY_KEY, merged as unknown as Prisma.InputJsonValue, updatedBy.user_id, expected, description);
      if (!saved) {
        throw new SettingsError(
          'SETTINGS_CHANGED',
          'Discount settings were changed by someone else after you opened them. Reload to see the current values, then make your change again.',
          409,
          { current: await settingsService.getDiscountPolicy() },
        );
      }
    }

    await recordAuditLog({
      action: 'DISCOUNT_POLICY_UPDATED',
      entityType: 'system_setting',
      entityId: DISCOUNT_POLICY_KEY,
      actorId: updatedBy.user_id,
      actorRole: updatedBy.role,
      beforeState: before,
      afterState: merged,
      ipAddress,
    });

    return { ...merged, updatedAt: saved.updatedAt.toISOString(), updatedBy: updatedBy.user_id, statutoryTypes: [...STATUTORY_DISCOUNT_TYPES] };
  },

  /**
   * POS-PERF-P50 — the tax configuration checkout uses right now. Statutory
   * values and fixed application behavior come from @potato-corner/shared
   * (the same constants computeSaleTax uses); the discount rates come from
   * Discount Settings. POS-PERF-P50R — scoped to one branch for a
   * staff/branch caller or with ?branch_id=, adding its VAT registration.
   */
  async getTaxConfiguration(actor?: ActorContext, branchId?: string): Promise<TaxConfigurationResponse> {
    const base = {
      vatRatePercent: VAT_RATE_PERCENT,
      pricesIncludeVat: PRICES_INCLUDE_VAT,
      statutoryDiscountPercent: STATUTORY_DISCOUNT_PERCENT,
      vatExemptDiscountTypes: [...VAT_EXEMPT_DISCOUNT_TYPES],
    };
    const scoped = (actor ? branchBoundId(actor) : null) ?? branchId ?? null;
    if (!scoped) {
      const policy = await settingsService.getDiscountPolicy();
      return {
        ...base,
        scope: 'organization',
        discountRates: { pwd: policy.pwd.percentage, senior_citizen: policy.senior_citizen.percentage, employee: policy.employee.percentage },
        statutoryRateMismatch: statutoryRowsOffStatute(policy),
      };
    }
    if (actor) await assertBranchAccess(scoped, actor);
    const { policy, vatRegistration } = await settingsService.getEffectiveDiscountPolicy(scoped);
    return {
      ...base,
      scope: 'branch',
      discountRates: { pwd: policy.pwd.percentage, senior_citizen: policy.senior_citizen.percentage, employee: policy.employee.percentage },
      statutoryRateMismatch: statutoryRowsOffStatute(policy),
      branchId: scoped,
      vatRegistration,
    };
  },

  /** POS-PERF-P50R — Settings → Discounts & VAT for one branch: defaults, override, effective values and permissions. */
  async getBranchDiscountSettings(branchId: string, actor: ActorContext): Promise<BranchDiscountSettingsResponse> {
    await assertBranchAccess(branchId, actor);
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new SettingsError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    return settingsService.describeBranchDiscountSettings(branchId, branch.name, actor);
  },

  async describeBranchDiscountSettings(branchId: string, branchName: string, actor: ActorContext): Promise<BranchDiscountSettingsResponse> {
    const [effective, taxRow] = await Promise.all([
      settingsService.getEffectiveDiscountPolicy(branchId),
      settingsRepository.findSystemSetting(branchTaxProfileKey(branchId)),
    ]);
    const { organization, policy, sources } = effective;
    return {
      branchId,
      branchName,
      organization: { pwd: organization.pwd, senior_citizen: organization.senior_citizen, employee: organization.employee, updatedAt: organization.updatedAt },
      override: effective.override,
      effective: {
        pwd: { ...policy.pwd, source: sources.pwd },
        senior_citizen: { ...policy.senior_citizen, source: sources.senior_citizen },
        employee: { ...policy.employee, source: sources.employee },
        requireDiscountChoice: effective.requireDiscountChoice,
      },
      taxProfile: readTaxProfile(branchId, taxRow),
      updatedAt: effective.overrideUpdatedAt,
      updatedBy: effective.overrideUpdatedBy,
      canEdit: actor.role === ROLES.SUPER_ADMIN || actor.role === ROLES.SUPERVISOR,
      canEditTaxProfile: actor.role === ROLES.SUPER_ADMIN,
    };
  },

  /**
   * POS-PERF-P50R — saves one branch's override. Authority: Super Admin, or
   * a supervisor with a live active assignment to this active branch
   * (re-read from the database, never the JWT). The whole override is
   * replaced (null = use the organization default). Stale saves are
   * refused: the caller sends the override's updatedAt it loaded (null =
   * none yet); there is no last-write-wins path.
   */
  async updateBranchDiscountSettings(
    branchId: string,
    data: UpdateBranchDiscountSettingsInput,
    actor: ActorContext,
    ipAddress: string | null,
  ): Promise<BranchDiscountSettingsResponse> {
    if (actor.role !== ROLES.SUPER_ADMIN && actor.role !== ROLES.SUPERVISOR) {
      throw new SettingsError('BRANCH_ACCESS_DENIED', 'You cannot change discount settings.', 403);
    }
    await assertBranchAccess(branchId, actor);
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new SettingsError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    if (branch.status !== 'active') throw new SettingsError('BRANCH_INACTIVE', 'Discounts can only be changed for an active branch.', 422);
    if (data.pwdPercentage !== null && !isLawfulPwdRate(data.pwdPercentage)) {
      throw new SettingsError('STATUTORY_DISCOUNT_LOCKED', `The PWD discount must be at least ${STATUTORY_DISCOUNT_PERCENT}% (RA 10754) and at most 100%.`, 422);
    }

    const before = await settingsService.describeBranchDiscountSettings(branchId, branch.name, actor);
    const value: BranchDiscountOverride = { employee: data.employee, pwdPercentage: data.pwdPercentage, requireDiscountChoice: data.requireDiscountChoice };
    const expected = data.expectedUpdatedAt === null ? null : new Date(data.expectedUpdatedAt);
    const stale = (expected?.toISOString() ?? null) !== before.updatedAt;
    const saved = stale
      ? null
      : await settingsRepository.writeSystemSettingIfUnchanged(
          branchDiscountKey(branchId),
          value as unknown as Prisma.InputJsonValue,
          actor.user_id,
          expected,
          'Branch override of POS discount settings (POS-PERF-P50R)',
        );
    if (!saved) {
      throw new SettingsError(
        'SETTINGS_CHANGED',
        `Discount settings for ${branch.name} were changed by someone else after you opened them. Reload to see the current values, then make your change again.`,
        409,
        { current: await settingsService.describeBranchDiscountSettings(branchId, branch.name, actor) },
      );
    }
    const after = await settingsService.describeBranchDiscountSettings(branchId, branch.name, actor);
    await recordAuditLog({
      action: 'BRANCH_DISCOUNT_SETTINGS_UPDATED',
      entityType: 'system_setting',
      entityId: branchDiscountKey(branchId),
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId,
      beforeState: { override: before.override, effective: before.effective },
      afterState: { override: after.override, effective: after.effective },
      ipAddress,
    });
    return after;
  },

  /**
   * POS-PERF-P50R — records a branch's VAT registration: a legal fact the
   * owner supplies, Super Admin only, audited, never changed implicitly.
   * 'non_vat_registered' is refused: this release cannot calculate or
   * receipt a non-VAT sale (runbook D1). The record does not change how
   * checkout calculates — every branch is calculated as VAT-registered.
   */
  async updateBranchTaxProfile(
    branchId: string,
    data: UpdateBranchTaxProfileInput,
    actor: ActorContext,
    ipAddress: string | null,
  ): Promise<BranchTaxProfileResponse> {
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw new SettingsError('TAX_PROFILE_ADMIN_ONLY', "Only a Super Admin can record a branch's VAT registration.", 403);
    }
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new SettingsError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    if (!SUPPORTED_VAT_REGISTRATION_STATUSES.includes(data.vatRegistration as VatRegistrationStatus)) {
      throw new SettingsError(
        'TAX_TREATMENT_NOT_SUPPORTED',
        'Non-VAT registration is not supported yet: a non-VAT branch needs a different calculation and receipt that this version does not have. Leave the branch unconfirmed and contact the system owner.',
        422,
      );
    }
    const key = branchTaxProfileKey(branchId);
    const before = readTaxProfile(branchId, await settingsRepository.findSystemSetting(key));
    const expected = data.expectedUpdatedAt === null ? null : new Date(data.expectedUpdatedAt);
    const stale = (expected?.toISOString() ?? null) !== before.updatedAt;
    const saved = stale
      ? null
      : await settingsRepository.writeSystemSettingIfUnchanged(
          key,
          { vatRegistration: data.vatRegistration, note: data.note } as unknown as Prisma.InputJsonValue,
          actor.user_id,
          expected,
          'Branch VAT registration as recorded by a Super Admin (POS-PERF-P50R)',
        );
    if (!saved) {
      throw new SettingsError(
        'SETTINGS_CHANGED',
        `The VAT registration for ${branch.name} was changed by someone else after you opened it. Reload and check it again.`,
        409,
        { current: before },
      );
    }
    const after = readTaxProfile(branchId, saved);
    await recordAuditLog({
      action: 'BRANCH_TAX_PROFILE_UPDATED',
      entityType: 'system_setting',
      entityId: key,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId,
      beforeState: before,
      afterState: after,
      ipAddress,
    });
    return after;
  },

  /**
   * P3D-P4 — Super Admin-configurable regular-shift length. Same KV
   * precedent as getDiscountPolicy/getSecurityPolicy: an absent SystemSetting
   * row means DEFAULT_WORK_HOURS_POLICY (8h), which is the exact value
   * attendance.service.ts's STANDARD_SHIFT_MINUTES hardcoded before this
   * setting existed — a fresh install or pre-save state behaves identically
   * to today's production.
   */
  async getWorkHoursPolicy(): Promise<WorkHoursPolicyResponse> {
    const setting = await settingsRepository.findSystemSetting(WORK_HOURS_POLICY_KEY);
    if (!setting) return { ...DEFAULT_WORK_HOURS_POLICY, updatedAt: null, updatedBy: null };
    const value = setting.value as unknown as { regularHours: number };
    return { ...value, updatedAt: setting.updatedAt.toISOString(), updatedBy: setting.updatedBy };
  },

  async updateWorkHoursPolicy(
    data: UpdateWorkHoursPolicyInput,
    updatedBy: ActorContext,
    ipAddress: string | null,
  ): Promise<WorkHoursPolicyResponse> {
    const before = await settingsService.getWorkHoursPolicy();

    await settingsRepository.upsertSystemSetting(
      WORK_HOURS_POLICY_KEY,
      data as unknown as Prisma.InputJsonValue,
      updatedBy.user_id,
      'Configurable regular work hours per shift before overtime accrues',
    );

    await recordAuditLog({
      action: 'WORK_HOURS_POLICY_UPDATED',
      entityType: 'system_setting',
      entityId: WORK_HOURS_POLICY_KEY,
      actorId: updatedBy.user_id,
      actorRole: updatedBy.role,
      beforeState: before,
      afterState: data,
      ipAddress,
    });

    const updated = await settingsRepository.findSystemSetting(WORK_HOURS_POLICY_KEY);
    return { ...data, updatedAt: updated?.updatedAt.toISOString() ?? new Date().toISOString(), updatedBy: updatedBy.user_id };
  },

  /**
   * Canonical resolver for the regular-shift threshold in minutes — the ONE
   * place attendance.service.ts (clockOut and manualOverride alike) reads
   * this from, so the configured value can never drift between the two call
   * sites. Converts the admin-facing hours value to integer minutes via
   * Math.round to avoid fractional-minute ambiguity (e.g. 7.501h). Falls
   * back to DEFAULT_WORK_HOURS_POLICY (480 minutes) on a missing row, same
   * fallback semantics as getWorkHoursPolicy.
   */
  async getRegularShiftMinutes(branchId?: string): Promise<number> {
    if (branchId) {
      const effective = await settingsService.getBranchWorkHours(branchId);
      return Math.round(effective.regularHours * 60);
    }
    const policy = await settingsService.getWorkHoursPolicy();
    return Math.round(policy.regularHours * 60);
  },

  /**
   * POS-PERF-P40 — effective regular hours for one branch: its own override
   * row when present, otherwise the global policy (itself defaulting to 8h).
   * Access is checked by the caller (router hasBranchAccess) for reads that
   * originate from a request; attendance's internal calls pass a branch the
   * record already belongs to.
   */
  async getBranchWorkHours(branchId: string, branchName: string | null = null): Promise<BranchWorkHoursResponse> {
    const [global, override] = await Promise.all([
      settingsService.getWorkHoursPolicy(),
      settingsRepository.findSystemSetting(branchWorkHoursKey(branchId)),
    ]);
    const overrideHours = override ? (override.value as unknown as { regularHours: number }).regularHours : null;
    return {
      branchId,
      branchName,
      regularHours: overrideHours ?? global.regularHours,
      source: overrideHours !== null ? 'branch' : 'global',
      overrideHours,
      globalHours: global.regularHours,
      updatedAt: override ? override.updatedAt.toISOString() : global.updatedAt,
      updatedBy: override ? override.updatedBy : global.updatedBy,
    };
  },

  /** Read-only roll-up for the Admin Settings view: every branch's effective value and where it comes from. */
  async listBranchWorkHours(): Promise<{ global: WorkHoursPolicyResponse; branches: BranchWorkHoursResponse[] }> {
    const [global, overrides, branches] = await Promise.all([
      settingsService.getWorkHoursPolicy(),
      settingsRepository.findSystemSettingsByPrefix(BRANCH_WORK_HOURS_KEY_PREFIX),
      branchesRepository.findAllNames(),
    ]);
    const overrideByBranch = new Map(overrides.map((row) => [row.key.slice(BRANCH_WORK_HOURS_KEY_PREFIX.length), row]));
    return {
      global,
      branches: branches.map((branch) => {
        const row = overrideByBranch.get(branch.id);
        const overrideHours = row ? (row.value as unknown as { regularHours: number }).regularHours : null;
        return {
          branchId: branch.id,
          branchName: branch.name,
          regularHours: overrideHours ?? global.regularHours,
          source: overrideHours !== null ? 'branch' : 'global',
          overrideHours,
          globalHours: global.regularHours,
          updatedAt: row ? row.updatedAt.toISOString() : global.updatedAt,
          updatedBy: row ? row.updatedBy : global.updatedBy,
        };
      }),
    };
  },

  async setBranchWorkHours(
    branchId: string,
    data: UpdateBranchWorkHoursInput,
    actor: ActorContext,
    ipAddress: string | null,
  ): Promise<BranchWorkHoursResponse> {
    const before = await settingsService.getBranchWorkHours(branchId);
    await settingsRepository.upsertSystemSetting(
      branchWorkHoursKey(branchId),
      data as unknown as Prisma.InputJsonValue,
      actor.user_id,
      'Branch override of regular work hours before overtime accrues',
    );
    await recordAuditLog({
      action: 'BRANCH_WORK_HOURS_UPDATED',
      entityType: 'system_setting',
      entityId: branchWorkHoursKey(branchId),
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId,
      beforeState: before,
      afterState: data,
      ipAddress,
    });
    return settingsService.getBranchWorkHours(branchId);
  },

  /** Removes the override so the branch falls back to the global value again. */
  async clearBranchWorkHours(branchId: string, actor: ActorContext, ipAddress: string | null): Promise<BranchWorkHoursResponse> {
    const before = await settingsService.getBranchWorkHours(branchId);
    await settingsRepository.deleteSystemSetting(branchWorkHoursKey(branchId));
    if (before.source === 'branch') {
      await recordAuditLog({
        action: 'BRANCH_WORK_HOURS_CLEARED',
        entityType: 'system_setting',
        entityId: branchWorkHoursKey(branchId),
        actorId: actor.user_id,
        actorRole: actor.role,
        branchId,
        beforeState: before,
        afterState: { regularHours: before.globalHours, source: 'global' },
        ipAddress,
      });
    }
    return settingsService.getBranchWorkHours(branchId);
  },

  /** POS-PERF-P16 — current operational write-gate state, plus this process's own in-flight gated-request count (see middleware/write-gate.ts). */
  async getWriteGate(): Promise<WriteGateResponse> {
    const setting = await settingsRepository.findSystemSetting(WRITE_GATE_KEY);
    const state = resolveWriteGateState(setting?.value);
    return {
      enabled: state.enabled,
      reason: state.reason,
      updatedAt: setting?.updatedAt.toISOString() ?? null,
      updatedBy: setting?.updatedBy ?? null,
      activeGatedRequests: getActiveGatedRequestCount(),
    };
  },

  /**
   * POS-PERF-P16 — opens or closes the write gate. Enabling requires a
   * reason (enforced by updateWriteGateSchema at the router layer, and
   * re-checked here since this is the actual write path); disabling does
   * not. Audit-logged either way — this is the one lever that blocks every
   * cashier's checkout and every branch's inventory writes at once, so who
   * flipped it and why must be in the tamper-evident audit chain, not just
   * this row's own updatedBy/updatedAt columns.
   */
  async setWriteGate(data: UpdateWriteGateInput, updatedBy: ActorContext, ipAddress: string | null): Promise<WriteGateResponse> {
    if (data.enabled && !data.reason) {
      throw new SettingsError('REASON_REQUIRED', 'A reason is required when closing the write gate', 422);
    }

    const before = await settingsService.getWriteGate();
    const value: WriteGateStateValue = { enabled: data.enabled, reason: data.enabled ? (data.reason as string) : null };

    await settingsRepository.upsertSystemSetting(
      WRITE_GATE_KEY,
      value as unknown as Prisma.InputJsonValue,
      updatedBy.user_id,
      'Operational write gate — blocks checkout and inventory-mutating writes during a maintenance window (POS-PERF-P16)',
    );

    await recordAuditLog({
      action: data.enabled ? 'WRITE_GATE_ENABLED' : 'WRITE_GATE_DISABLED',
      entityType: 'system_setting',
      entityId: WRITE_GATE_KEY,
      actorId: updatedBy.user_id,
      actorRole: updatedBy.role,
      beforeState: before,
      afterState: value,
      ipAddress,
    });

    return settingsService.getWriteGate();
  },
};
