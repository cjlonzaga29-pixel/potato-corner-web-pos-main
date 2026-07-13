import { prisma } from '../../lib/prisma.js';
import { sha256Hex } from '../../lib/hash.js';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000;

/**
 * Auth repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const authRepository = {
  findUserByEmail(email: string) {
    return prisma.user.findUnique({
      where: { email },
      include: { branchAssignments: { where: { removedAt: null } } },
    });
  },

  findUserById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        role: true,
        firstName: true,
        lastName: true,
        isActive: true,
        mustChangePassword: true,
        branchAssignments: { where: { removedAt: null }, select: { branchId: true } },
      },
    });
  },

  updateLastLogin(userId: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    });
  },

  async incrementLoginAttempts(userId: string) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { loginAttempts: { increment: 1 } },
    });

    if (user.loginAttempts >= LOCKOUT_THRESHOLD) {
      await this.lockAccount(userId);
    }

    return user;
  },

  lockAccount(userId: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) },
    });
  },

  /** Manual Super Admin unlock also goes through this — clears both counters. */
  resetLoginAttempts(userId: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { loginAttempts: 0, lockedUntil: null },
    });
  },

  storeRefreshToken(userId: string, token: string, deviceId: string, expiresAt: Date) {
    return prisma.refreshToken.create({
      data: { userId, tokenHash: sha256Hex(token), deviceId, expiresAt },
    });
  },

  findRefreshToken(token: string) {
    return prisma.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: { include: { branchAssignments: { where: { removedAt: null } } } } },
    });
  },

  /** Atomic rotation: revoke the old token and create its replacement in one transaction. */
  rotateRefreshToken(oldTokenId: string, newToken: string, newExpiresAt: Date) {
    return prisma.$transaction(async (tx) => {
      const old = await tx.refreshToken.update({
        where: { id: oldTokenId },
        data: { revokedAt: new Date() },
      });

      const created = await tx.refreshToken.create({
        data: {
          userId: old.userId,
          tokenHash: sha256Hex(newToken),
          deviceId: old.deviceId,
          expiresAt: newExpiresAt,
        },
      });

      await tx.refreshToken.update({ where: { id: oldTokenId }, data: { replacedBy: created.id } });
      return created;
    });
  },

  revokeAllUserTokens(userId: string) {
    return prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  revokeRefreshToken(id: string) {
    return prisma.refreshToken.update({ where: { id }, data: { revokedAt: new Date() } });
  },

  findUserWithPasswordById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },

  storePinHash(userId: string, deviceId: string, pinHash: string) {
    return prisma.pinCredential.upsert({
      where: { userId_deviceId: { userId, deviceId } },
      create: { userId, deviceId, pinHash },
      update: { pinHash },
    });
  },

  findPinHash(userId: string, deviceId: string) {
    return prisma.pinCredential.findUnique({
      where: { userId_deviceId: { userId, deviceId } },
    });
  },

  /** A device only qualifies for PIN login once it has an active refresh token for this user. */
  hasActiveDeviceSession(userId: string, deviceId: string) {
    return prisma.refreshToken.findFirst({
      where: { userId, deviceId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
  },

  updatePasswordHash(userId: string, passwordHash: string) {
    return prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  },

  setMustChangePassword(userId: string, mustChangePassword: boolean) {
    return prisma.user.update({ where: { id: userId }, data: { mustChangePassword } });
  },
};
