import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { UpdateBranchReceiptConfigData, UpdateNotificationPreferenceData } from './settings.types.js';

export const settingsRepository = {
  findSystemSetting(key: string) {
    return prisma.systemSetting.findUnique({ where: { key } });
  },

  upsertSystemSetting(key: string, value: Prisma.InputJsonValue, updatedBy: string, description?: string) {
    return prisma.systemSetting.upsert({
      where: { key },
      create: { key, value, description, updatedBy },
      update: { value, updatedBy, ...(description !== undefined ? { description } : {}) },
    });
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
};
