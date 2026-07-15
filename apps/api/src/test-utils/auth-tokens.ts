import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { ROLES, type Role } from '@potato-corner/shared';
import { config } from '../config/index.js';

export interface TestTokenOptions {
  userId?: string;
  email?: string;
  branchIds?: string[];
  /** Signs a token whose `exp` is already in the past. */
  expired?: boolean;
}

function buildPayload(role: Role, options: TestTokenOptions): Record<string, unknown> {
  const userId = options.userId ?? randomUUID();
  const email = options.email ?? `${role}@potatocorner.test`;

  if (role === ROLES.SUPER_ADMIN) {
    return { user_id: userId, role, email };
  }

  const branchIds = options.branchIds ?? [randomUUID()];
  return { user_id: userId, role, email, branch_ids: branchIds };
}

/**
 * Generates a real RS256-signed JWT for tests, using the same keys and
 * payload shape as auth.service.ts's `buildJwtPayload` — no `jti`, per the
 * locked JWT structure (see auth.types.ts). There is no `blacklisted`
 * option here: blacklisting is a Redis lookup keyed by the token's own
 * hash (see middleware/authenticate.ts `blacklistKey`), not anything
 * encoded in the token — simulate it in the consuming test by mocking
 * `redis.get` to resolve truthy for that token.
 */
export function generateTestToken(role: Role, options: TestTokenOptions = {}): string {
  const payload = buildPayload(role, options);

  if (options.expired) {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({ ...payload, iat: now - 3600, exp: now - 1800 }, config.jwt.privateKey, {
      algorithm: 'RS256',
    });
  }

  return jwt.sign(payload, config.jwt.privateKey, {
    algorithm: 'RS256',
    expiresIn: config.jwt.accessTokenTtl as jwt.SignOptions['expiresIn'],
  });
}

export function generateSuperAdminToken(options: Omit<TestTokenOptions, 'branchIds'> = {}): string {
  return generateTestToken(ROLES.SUPER_ADMIN, options);
}

export function generateSupervisorToken(branchIds: string[], options: TestTokenOptions = {}): string {
  return generateTestToken(ROLES.SUPERVISOR, { ...options, branchIds });
}

export function generateStaffToken(branchId: string, options: TestTokenOptions = {}): string {
  return generateTestToken(ROLES.STAFF, { ...options, branchIds: [branchId] });
}
