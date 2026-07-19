import type { Prisma } from '@prisma/client';
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

  /** Phase 21: Postgres replacement for the Redis access-token blacklist (see verify-access-token.ts). */
  insertRevokedToken(tokenHash: string, expiresAt: Date) {
    return prisma.revokedToken.upsert({
      where: { tokenHash },
      create: { tokenHash, expiresAt },
      update: { expiresAt },
    });
  },

  /** Phase 21: Postgres replacement for the Redis-backed password reset token. Upsert — a fresh reset request replaces any still-live prior token for the same value. */
  storePasswordResetToken(tokenHash: string, userId: string, expiresAt: Date) {
    return prisma.passwordResetToken.upsert({
      where: { tokenHash },
      create: { tokenHash, userId, expiresAt },
      update: { userId, expiresAt },
    });
  },

  findPasswordResetToken(tokenHash: string) {
    return prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  },

  /** deleteMany (not delete) so a second consume of an already-used/expired token can't throw on a missing row. */
  deletePasswordResetToken(tokenHash: string) {
    return prisma.passwordResetToken.deleteMany({ where: { tokenHash } });
  },

  /**
   * Phase 21: Postgres replacement for the Redis lock that used to serialize
   * concurrent refresh-token rotations for the same token (Phase 20.5,
   * commit 9507200). pg_advisory_xact_lock is session-scoped, so the lock
   * acquisition and every query it's meant to guard must run on the same
   * connection — hence `fn` receives the transaction client `tx` and must
   * use it (not the top-level `prisma`) for every read/write it needs
   * serialized against concurrent callers. The lock releases automatically
   * on transaction commit/rollback.
   *
   * Unlike the Redis version, there is no result cache: a second request
   * that arrives after the first has already committed will see the token
   * as rotated/revoked and get REFRESH_INVALID, not the first request's
   * result. This reopens the narrow concurrent-refresh race Phase 20.5
   * closed — accepted per the Phase 21 directive to drop Redis-backed
   * caching entirely, not merely relocate it.
   */
  withAdvisoryLock<T>(lockId: bigint, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
      return fn(tx);
    });
  },

  findRefreshTokenTx(tx: Prisma.TransactionClient, token: string) {
    return tx.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: { include: { branchAssignments: { where: { removedAt: null } } } } },
    });
  },

  /** Same rotation logic as rotateRefreshToken above, but running on the caller's transaction client instead of opening its own. */
  async rotateRefreshTokenTx(tx: Prisma.TransactionClient, oldTokenId: string, newToken: string, newExpiresAt: Date) {
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
  },
};
