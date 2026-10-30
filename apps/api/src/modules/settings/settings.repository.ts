import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type {
  UpdateBranchPaymentMethodConfigData,
  UpdateBranchReceiptConfigData,
  UpdateNotificationPreferenceData,
} from './settings.types.js';

export const settingsRepository = {
  findSystemSetting(key: string) {
    return prisma.systemSetting.findUnique({ where: { key } });
  },

  findSystemSettingsByPrefix(prefix: string) {
    return prisma.systemSetting.findMany({ where: { key: { startsWith: prefix } } });
  },

  /** deleteMany (not delete) so clearing an override that is already absent is a no-op rather than a P2025 error. */
  deleteSystemSetting(key: string) {
    return prisma.systemSetting.deleteMany({ where: { key } });
  },

  upsertSystemSetting(key: string, value: Prisma.InputJsonValue, updatedBy: string, description?: string) {
    return prisma.systemSetting.upsert({
      where: { key },
      create: { key, value, description, updatedBy },
      update: { value, updatedBy, ...(description !== undefined ? { description } : {}) },
    });
  },

  /**
   * POS-PERF-P50 — compare-and-set write: succeeds only if the row is still
   * at expectedUpdatedAt (or still absent when that is null). Returns null
   * when someone else saved in between, so the caller can refuse instead of
   * overwriting. Single statement each way, so two concurrent saves cannot
   * both pass.
   */
  async writeSystemSettingIfUnchanged(
    key: string,
    value: Prisma.InputJsonValue,
    updatedBy: string,
    expectedUpdatedAt: Date | null,
    description?: string,
  ) {
    if (expectedUpdatedAt === null) {
      try {
        return await prisma.systemSetting.create({ data: { key, value, description, updatedBy } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
        throw error;
      }
    }
    const result = await prisma.systemSetting.updateMany({
      where: { key, updatedAt: expectedUpdatedAt },
      data: { value, updatedBy, updatedAt: new Date(), ...(description !== undefined ? { description } : {}) },
    });
    if (result.count === 0) return null;
    return prisma.systemSetting.findUnique({ where: { key } });
  },

  findNotificationPreference(userId: string) {
    return prisma.notificationPreference.findUnique({ where: { userId } });
  },

  createDefaultNotificationPreference(userId: string) {
    return prisma.notificationPreference.create({ data: { userId } });
  },

  updateNotificationPreference(userId: string, data: UpdateNotificationPreferenceData) {
    return prisma.notificationPreference.update({ where: { userId }, data });
  },

  findBranchReceiptConfig(branchId: string) {
    return prisma.branchReceiptConfig.findUnique({ where: { branchId } });
  },

  upsertBranchReceiptConfig(branchId: string, data: UpdateBranchReceiptConfigData, updatedBy: string) {
    return prisma.branchReceiptConfig.upsert({
      where: { branchId },
      create: {
        branchId,
        headerText: data.headerText,
        footerText: data.footerText,
        showBranchLogo: data.showBranchLogo ?? true,
        updatedBy,
      },
      update: { ...data, updatedBy },
    });
  },

  findPaymentMethodConfig(branchId: string) {
    return prisma.branchPaymentMethodConfig.findUnique({ where: { branchId } });
  },

  upsertPaymentMethodConfig(branchId: string, data: UpdateBranchPaymentMethodConfigData, updatedBy: string) {
    return prisma.branchPaymentMethodConfig.upsert({
      where: { branchId },
      create: {
        branchId,
        cashEnabled: data.cashEnabled ?? true,
        gcashEnabled: data.gcashEnabled ?? true,
        updatedBy,
      },
      update: { ...data, updatedBy },
    });
  },
};
