import type {
  JwtPayload,
  NotificationPreferences,
  ReceiptConfigResponse,
  SecurityPolicy,
  UpdateNotificationPreferencesInput,
  UpdateReceiptConfigInput,
  UpdateSecurityPolicyInput,
} from '@potato-corner/shared';
import type {
  NotificationPreference as NotificationPreferenceRow,
  BranchReceiptConfig as BranchReceiptConfigRow,
  Prisma,
} from '@prisma/client';
import { settingsRepository } from './settings.repository.js';
import { DEFAULT_SECURITY_POLICY, SECURITY_POLICY_KEY, SettingsError } from './settings.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { branchesRepository } from '../branches/branches.repository.js';

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
};
