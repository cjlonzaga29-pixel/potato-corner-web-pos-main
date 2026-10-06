import {
  type JwtPayload,
  type NotificationPreferences,
  type PaymentMethodConfigResponse,
  type ReceiptConfigResponse,
  type SecurityPolicy,
  type DiscountPolicy,
  type DiscountPolicyResponse,
  type WorkHoursPolicyResponse,
  type WriteGateResponse,
  type UpdateNotificationPreferencesInput,
  type UpdatePaymentMethodConfigInput,
  type UpdateReceiptConfigInput,
  type UpdateSecurityPolicyInput,
  type UpdateDiscountPolicyInput,
  type UpdateWorkHoursPolicyInput,
  type UpdateWriteGateInput,
  CONFIGURABLE_DISCOUNT_TYPES,
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
  DEFAULT_WRITE_GATE_STATE,
  WRITE_GATE_KEY,
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
    const setting = await settingsRepository.findSystemSetting(DISCOUNT_POLICY_KEY);
    if (!setting) return { ...DEFAULT_DISCOUNT_POLICY, updatedAt: null, updatedBy: null };
    const value = setting.value as unknown as DiscountPolicy;
    return { ...value, updatedAt: setting.updatedAt.toISOString(), updatedBy: setting.updatedBy };
  },

  async updateDiscountPolicy(
    data: UpdateDiscountPolicyInput,
    updatedBy: ActorContext,
    ipAddress: string | null,
  ): Promise<DiscountPolicyResponse> {
    const before = await settingsService.getDiscountPolicy();

    // Partial per-type PUT — merge the incoming partial entries over the
    // currently persisted (or default) policy, same precedent as
    // updatePaymentMethodConfig's merge-then-validate.
    const merged: DiscountPolicy = { ...DEFAULT_DISCOUNT_POLICY };
    for (const type of CONFIGURABLE_DISCOUNT_TYPES) {
      merged[type] = { ...before[type], ...data[type] };
    }

    await settingsRepository.upsertSystemSetting(
      DISCOUNT_POLICY_KEY,
      merged as unknown as Prisma.InputJsonValue,
      updatedBy.user_id,
      'Configurable POS discount percentages (PWD, Senior Citizen, Employee, Promotional)',
    );

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

    const updated = await settingsRepository.findSystemSetting(DISCOUNT_POLICY_KEY);
    return { ...merged, updatedAt: updated?.updatedAt.toISOString() ?? new Date().toISOString(), updatedBy: updatedBy.user_id };
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
  async getRegularShiftMinutes(): Promise<number> {
    const policy = await settingsService.getWorkHoursPolicy();
    return Math.round(policy.regularHours * 60);
  },

  /** POS-PERF-P16 — current operational write-gate state, plus this process's own in-flight gated-request count (see middleware/write-gate.ts). */
  async getWriteGate(): Promise<WriteGateResponse> {
    const setting = await settingsRepository.findSystemSetting(WRITE_GATE_KEY);
    const state = (setting?.value as unknown as WriteGateStateValue | undefined) ?? DEFAULT_WRITE_GATE_STATE;
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
