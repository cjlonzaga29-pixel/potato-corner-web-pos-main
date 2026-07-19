import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { ROLES, type Role } from '@potato-corner/shared';
import { authRepository } from './auth.repository.js';
import { AuthError, type AuthenticatedUserSummary, type LoginResponse, type RefreshResponse } from './auth.types.js';
import { config } from '../../config/index.js';
import { redis } from '../../lib/redis.js';
import { sha256Hex, randomOpaqueToken } from '../../lib/hash.js';
import { parseDurationMs } from '../../lib/duration.js';
import { sendPasswordResetEmail } from '../../lib/email.js';
import { blacklistKey } from '../../middleware/authenticate.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

const BCRYPT_COST_FACTOR = 12;
const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

interface AccessTokenUser {
  id: string;
  role: Role;
  email: string;
  branchIds: string[];
  /** Optional so existing call sites/tests that predate Phase 5 keep compiling — defaults to false (real login/refresh/pin-login paths always pass the real DB value explicitly). */
  mustChangePassword?: boolean;
}

/**
 * Builds the JWT payload exactly per the locked structure:
 *   super_admin: { user_id, role, email }
 *   supervisor / staff: { user_id, role, email, branch_ids }
 * plus Phase 5's must_change_password addition (see the design note on
 * jwtPayloadSchema in @potato-corner/shared/schemas/auth.schema.ts).
 * `iat`/`exp` are added by jwt.sign via `expiresIn`, not set manually.
 * No `jti` field — see the design note in auth.types.ts.
 */
function buildJwtPayload(user: AccessTokenUser): Record<string, unknown> {
  const mustChangePassword = user.mustChangePassword ?? false;
  if (user.role === ROLES.SUPER_ADMIN) {
    return { user_id: user.id, role: user.role, email: user.email, must_change_password: mustChangePassword };
  }
  return {
    user_id: user.id,
    role: user.role,
    email: user.email,
    branch_ids: user.branchIds,
    must_change_password: mustChangePassword,
  };
}

function generateAccessToken(user: AccessTokenUser): string {
  return jwt.sign(buildJwtPayload(user), config.jwt.privateKey, {
    algorithm: 'RS256',
    expiresIn: config.jwt.accessTokenTtl as jwt.SignOptions['expiresIn'],
  });
}

function generateRefreshToken(): string {
  return randomOpaqueToken();
}

// Phase 20.5: a client can present the same refresh token twice in quick
// succession (e.g. rapid sidebar navigation triggers the middleware's
// refresh check on two near-simultaneous requests before the first
// response lands). Without coalescing, the second request finds the token
// already rotated and bounces a legitimate user to /login. Rather than a
// blanket time-based amnesty for any recently-revoked token (which would
// also let a genuinely stolen token be replayed within that window), a
// short-lived Redis lock serializes concurrent rotations of the exact same
// token, and the rotation result is memoized for a few seconds under that
// token's own hash so a near-duplicate request gets back the identical
// replacement pair instead of racing the DB. Reuse of a token outside this
// narrow window — or from a different device — still throws REFRESH_INVALID.
const REFRESH_ROTATION_LOCK_TTL_MS = 5_000;
const REFRESH_ROTATION_RESULT_TTL_SECONDS = 10;
const REFRESH_ROTATION_WAIT_TIMEOUT_MS = 1_500;
const REFRESH_ROTATION_WAIT_INTERVAL_MS = 100;

type RefreshTokenPair = RefreshResponse & { refreshToken: string };

interface CachedRotation {
  deviceId: string;
  response: RefreshTokenPair;
}

function refreshLockKey(tokenHash: string): string {
  return `auth:refresh-lock:${tokenHash}`;
}

function refreshResultKey(tokenHash: string): string {
  return `auth:refresh-result:${tokenHash}`;
}

async function readCachedRotation(tokenHash: string, deviceId: string): Promise<RefreshTokenPair | null> {
  const raw = await redis.get(refreshResultKey(tokenHash));
  if (!raw) return null;
  const cached = JSON.parse(raw) as CachedRotation;
  return cached.deviceId === deviceId ? cached.response : null;
}

async function cacheRotationResult(tokenHash: string, deviceId: string, response: RefreshTokenPair): Promise<void> {
  const cached: CachedRotation = { deviceId, response };
  await redis.set(refreshResultKey(tokenHash), JSON.stringify(cached), 'EX', REFRESH_ROTATION_RESULT_TTL_SECONDS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls for the in-flight rotation's result while another request holds the lock for this token. */
async function waitForRotation(tokenHash: string, deviceId: string): Promise<RefreshTokenPair | null> {
  const deadline = Date.now() + REFRESH_ROTATION_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(REFRESH_ROTATION_WAIT_INTERVAL_MS);
    const cached = await readCachedRotation(tokenHash, deviceId);
    if (cached) return cached;
  }
  return null;
}

/** Blacklists an access token until its own expiry — same TTL, no longer, no shorter. */
async function blacklistToken(accessToken: string, expiresAt: Date): Promise<void> {
  const ttlSeconds = Math.max(Math.floor((expiresAt.getTime() - Date.now()) / 1000), 0);
  if (ttlSeconds === 0) return;
  await redis.set(blacklistKey(accessToken), '1', 'EX', ttlSeconds);
}

function decodeExpiry(accessToken: string): Date {
  const decoded = jwt.decode(accessToken) as { exp?: number } | null;
  return decoded?.exp ? new Date(decoded.exp * 1000) : new Date();
}

function toUserSummary(user: {
  id: string;
  role: Role;
  email: string;
  firstName: string;
  lastName: string;
  mustChangePassword: boolean;
}, branchIds: string[]): AuthenticatedUserSummary {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    first_name: user.firstName,
    last_name: user.lastName,
    branch_ids: branchIds,
    must_change_password: user.mustChangePassword,
  };
}

export const authService = {
  generateAccessToken,
  generateRefreshToken,
  blacklistToken,

  async login(email: string, password: string, deviceId: string, ipAddress: string | null): Promise<LoginResponse & { refreshToken: string }> {
    const user = await authRepository.findUserByEmail(email);

    if (!user) {
      // Generic message — do not reveal whether the email exists.
      throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutesRemaining = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw new AuthError('ACCOUNT_LOCKED', `Account locked. Try again in ${minutesRemaining} minute(s).`, 423, {
        minutesRemaining,
      });
    }

    // Lockout window has passed — auto-unlock before evaluating the password.
    if (user.lockedUntil && user.lockedUntil.getTime() <= Date.now()) {
      await authRepository.resetLoginAttempts(user.id);
      user.loginAttempts = 0;
      user.lockedUntil = null;
    }

    if (!user.isActive) {
      throw new AuthError('ACCOUNT_INACTIVE', 'This account has been deactivated', 403);
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      await authRepository.incrementLoginAttempts(user.id);
      await recordAuditLog({
        action: 'LOGIN_FAILURE',
        entityType: 'user',
        entityId: user.id,
        actorId: user.id,
        actorRole: user.role,
        ipAddress,
        afterState: { reason: 'invalid_password' },
      });
      throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }

    await authRepository.resetLoginAttempts(user.id);
    await authRepository.updateLastLogin(user.id);

    const branchIds = user.branchAssignments.map((assignment) => assignment.branchId);
    const accessToken = generateAccessToken({
      id: user.id,
      role: user.role,
      email: user.email,
      branchIds,
      mustChangePassword: user.mustChangePassword,
    });
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + parseDurationMs(config.jwt.refreshTokenTtl));
    await authRepository.storeRefreshToken(user.id, refreshToken, deviceId, refreshExpiresAt);

    await recordAuditLog({
      action: 'LOGIN_SUCCESS',
      entityType: 'user',
      entityId: user.id,
      actorId: user.id,
      actorRole: user.role,
      branchId: branchIds[0] ?? null,
      ipAddress,
    });

    return {
      access_token: accessToken,
      refreshToken,
      user: toUserSummary(user, branchIds),
    };
  },

  async refreshToken(refreshTokenValue: string, deviceId: string): Promise<RefreshTokenPair> {
    const tokenHash = sha256Hex(refreshTokenValue);
    const lockKey = refreshLockKey(tokenHash);

    // Coalescing is a Redis-dependent enhancement, not a correctness
    // requirement — the DB rotation below is what actually enforces
    // single-use tokens. If Redis is unavailable (e.g. an Upstash outage or
    // quota rejection), skip coalescing entirely rather than letting the
    // error bubble up and fail the whole refresh. This re-opens the narrow
    // concurrent-refresh race Phase 20.5 (commit 9507200) closed, but a
    // logged-out legitimate user is a smaller cost than the API being down.
    let acquiredLock: string | null = null;
    try {
      const alreadyRotated = await readCachedRotation(tokenHash, deviceId);
      if (alreadyRotated) return alreadyRotated;

      acquiredLock = await redis.set(lockKey, '1', 'PX', REFRESH_ROTATION_LOCK_TTL_MS, 'NX');

      if (!acquiredLock) {
        // Another request is mid-rotation for this exact token — wait for its
        // result instead of racing it against the same DB row.
        const waited = await waitForRotation(tokenHash, deviceId);
        if (waited) return waited;
        // Lock holder didn't finish in time (or crashed) — fall through to a
        // normal, unlocked lookup below.
      }
    } catch (error) {
      console.error('Refresh-token coalescing unavailable, proceeding without lock:', error);
      acquiredLock = null;
    }

    try {
      const stored = await authRepository.findRefreshToken(refreshTokenValue);

      if (!stored || stored.expiresAt.getTime() < Date.now() || stored.deviceId !== deviceId) {
        throw new AuthError('REFRESH_INVALID', 'Invalid or expired refresh token', 401);
      }

      if (stored.revokedAt) {
        // Already rotated, and no cache entry matched above — either a
        // stale duplicate past the short coalescing window or a genuine
        // replay of a stolen token. Log distinctly from a plain
        // expired/unknown token so real reuse stays visible.
        console.warn('Refresh token reuse detected', { userId: stored.user.id, tokenId: stored.id });
        throw new AuthError('REFRESH_INVALID', 'Invalid or expired refresh token', 401);
      }

      const branchIds = stored.user.branchAssignments.map((assignment) => assignment.branchId);
      const newRefreshToken = generateRefreshToken();
      const newExpiresAt = new Date(Date.now() + parseDurationMs(config.jwt.refreshTokenTtl));
      await authRepository.rotateRefreshToken(stored.id, newRefreshToken, newExpiresAt);

      const accessToken = generateAccessToken({
        id: stored.user.id,
        role: stored.user.role,
        email: stored.user.email,
        branchIds,
        mustChangePassword: stored.user.mustChangePassword,
      });

      const response: RefreshTokenPair = { access_token: accessToken, refreshToken: newRefreshToken };
      if (acquiredLock) {
        try {
          await cacheRotationResult(tokenHash, deviceId, response);
        } catch (error) {
          console.error('Failed to cache refresh rotation result:', error);
        }
      }
      return response;
    } finally {
      if (acquiredLock) {
        try {
          await redis.del(lockKey);
        } catch (error) {
          console.error('Failed to release refresh-token rotation lock:', error);
        }
      }
    }
  },

  async logout(accessToken: string, refreshTokenValue: string | undefined): Promise<void> {
    await blacklistToken(accessToken, decodeExpiry(accessToken));

    if (refreshTokenValue) {
      const stored = await authRepository.findRefreshToken(refreshTokenValue);
      if (stored && !stored.revokedAt) {
        await authRepository.revokeRefreshToken(stored.id);
      }
    }

    const decoded = jwt.decode(accessToken) as { user_id?: string; role?: string } | null;
    await recordAuditLog({
      action: 'LOGOUT',
      entityType: 'user',
      entityId: decoded?.user_id ?? null,
      actorId: decoded?.user_id ?? null,
      actorRole: decoded?.role ?? 'unknown',
    });
  },

  async logoutAllDevices(userId: string, accessToken: string): Promise<void> {
    await blacklistToken(accessToken, decodeExpiry(accessToken));
    await authRepository.revokeAllUserTokens(userId);
    await recordAuditLog({ action: 'LOGOUT_ALL_DEVICES', entityType: 'user', entityId: userId, actorId: userId, actorRole: 'unknown' });
  },

  /**
   * Unlike a self-service "forgot password" reset, this is called by an
   * already-authenticated user (voluntary change, or the mandatory
   * must-change-password flow) — so instead of forcing a full re-login, it
   * blacklists the now-stale token and every *other* session, then issues
   * this session a fresh token pair reflecting must_change_password: false.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    accessToken: string,
    deviceId: string,
  ): Promise<LoginResponse & { refreshToken: string }> {
    const user = await authRepository.findUserWithPasswordById(userId);
    if (!user) {
      throw new AuthError('USER_NOT_FOUND', 'User not found', 404);
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      throw new AuthError('INVALID_PASSWORD', 'Current password is incorrect', 401);
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_COST_FACTOR);
    await authRepository.updatePasswordHash(userId, newHash);
    await authRepository.setMustChangePassword(userId, false);

    // Password change blacklists all active tokens for that user (locked rule) — including this one, which is
    // about to be replaced with a fresh pair below so the current session doesn't get logged out too.
    await authRepository.revokeAllUserTokens(userId);
    await blacklistToken(accessToken, decodeExpiry(accessToken));

    const userWithBranches = await authRepository.findUserById(userId);
    const branchIds = userWithBranches?.branchAssignments.map((assignment) => assignment.branchId) ?? [];

    const newAccessToken = generateAccessToken({
      id: user.id,
      role: user.role,
      email: user.email,
      branchIds,
      mustChangePassword: false,
    });
    const newRefreshToken = generateRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + parseDurationMs(config.jwt.refreshTokenTtl));
    await authRepository.storeRefreshToken(userId, newRefreshToken, deviceId, refreshExpiresAt);

    await recordAuditLog({
      action: 'PASSWORD_CHANGED',
      entityType: 'user',
      entityId: userId,
      actorId: userId,
      actorRole: user.role,
    });

    return {
      access_token: newAccessToken,
      refreshToken: newRefreshToken,
      user: toUserSummary({ ...user, mustChangePassword: false }, branchIds),
    };
  },

  async requestPasswordReset(email: string): Promise<void> {
    const user = await authRepository.findUserByEmail(email);

    // Always behave the same way regardless of whether the email exists —
    // the router returns a generic success message either way.
    if (!user) return;

    const token = randomOpaqueToken();
    await redis.set(`auth:password-reset:${sha256Hex(token)}`, user.id, 'EX', PASSWORD_RESET_TTL_SECONDS);
    await sendPasswordResetEmail(user.email, token).catch((error: unknown) => {
      console.error('Failed to send password reset email:', error);
    });

    await recordAuditLog({
      action: 'PASSWORD_RESET_REQUESTED',
      entityType: 'user',
      entityId: user.id,
      actorId: user.id,
      actorRole: user.role,
    });
  },

  async resetPassword(resetToken: string, newPassword: string): Promise<void> {
    const key = `auth:password-reset:${sha256Hex(resetToken)}`;
    const userId = await redis.get(key);
    if (!userId) {
      throw new AuthError('RESET_TOKEN_INVALID', 'Invalid or expired reset token', 400);
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_COST_FACTOR);
    await authRepository.updatePasswordHash(userId, newHash);
    await authRepository.revokeAllUserTokens(userId);
    await redis.del(key);

    await recordAuditLog({
      action: 'PASSWORD_RESET_COMPLETED',
      entityType: 'user',
      entityId: userId,
      actorId: userId,
      actorRole: 'unknown',
    });
  },

  async validatePin(userId: string, deviceId: string, pin: string): Promise<LoginResponse> {
    const stored = await authRepository.findPinHash(userId, deviceId);
    if (!stored) {
      throw new AuthError('PIN_NOT_SET', 'No PIN registered for this device', 401);
    }

    const valid = await bcrypt.compare(pin, stored.pinHash);
    if (!valid) {
      throw new AuthError('PIN_INVALID', 'Invalid PIN', 401);
    }

    const user = await authRepository.findUserById(userId);
    if (!user || !user.isActive) {
      throw new AuthError('ACCOUNT_INACTIVE', 'This account has been deactivated', 403);
    }

    const branchIds = user.branchAssignments.map((assignment) => assignment.branchId);
    const accessToken = generateAccessToken({
      id: user.id,
      role: user.role,
      email: user.email,
      branchIds,
      mustChangePassword: user.mustChangePassword,
    });

    await recordAuditLog({
      action: 'PIN_LOGIN_SUCCESS',
      entityType: 'user',
      entityId: user.id,
      actorId: user.id,
      actorRole: user.role,
      branchId: branchIds[0] ?? null,
    });

    return { access_token: accessToken, user: toUserSummary(user, branchIds) };
  },

  /** Super Admin manual unlock — clears both lockout counters via the same repository call the auto-unlock path in login() uses. */
  async unlockAccount(userId: string, actor: { id: string; role: string }, ipAddress: string | null): Promise<void> {
    const user = await authRepository.findUserById(userId);
    if (!user) {
      throw new AuthError('USER_NOT_FOUND', 'User not found', 404);
    }

    await authRepository.resetLoginAttempts(userId);

    await recordAuditLog({
      action: 'ACCOUNT_UNLOCKED',
      entityType: 'user',
      entityId: userId,
      actorId: actor.id,
      actorRole: actor.role,
      ipAddress,
    });
  },

  async setPin(userId: string, deviceId: string, pin: string): Promise<void> {
    const hasSession = await authRepository.hasActiveDeviceSession(userId, deviceId);
    if (!hasSession) {
      throw new AuthError(
        'DEVICE_NOT_REGISTERED',
        'PIN login requires completing full email/password authentication on this device first',
        403,
      );
    }

    const pinHash = await bcrypt.hash(pin, BCRYPT_COST_FACTOR);
    await authRepository.storePinHash(userId, deviceId, pinHash);
  },
};
