import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { ROLES } from '@potato-corner/shared';

vi.mock('./auth.repository.js', () => ({
  authRepository: {
    findUserByEmail: vi.fn(),
    findUserById: vi.fn(),
    findUserWithPasswordById: vi.fn(),
    updateLastLogin: vi.fn(),
    incrementLoginAttempts: vi.fn(),
    lockAccount: vi.fn(),
    resetLoginAttempts: vi.fn(),
    storeRefreshToken: vi.fn(),
    findRefreshToken: vi.fn(),
    rotateRefreshToken: vi.fn(),
    revokeAllUserTokens: vi.fn(),
    revokeRefreshToken: vi.fn(),
    storePinHash: vi.fn(),
    findPinHash: vi.fn(),
    hasActiveDeviceSession: vi.fn(),
    updatePasswordHash: vi.fn(),
    setMustChangePassword: vi.fn(),
  },
}));

vi.mock('../../lib/redis.js', () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/email.js', () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

const { authRepository } = await import('./auth.repository.js');
const { redis } = await import('../../lib/redis.js');
const { authService } = await import('./auth.service.js');
const { config } = await import('../../config/index.js');

function buildUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    email: 'staff@potatocorner.test',
    passwordHash: '',
    role: ROLES.STAFF,
    firstName: 'Jane',
    lastName: 'Cruz',
    isActive: true,
    loginAttempts: 0,
    lockedUntil: null as Date | null,
    branchAssignments: [{ branchId: 'branch-1' }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authService.login', () => {
  it('returns an access token and refresh token for correct credentials', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorse1', 12);
    vi.mocked(authRepository.findUserByEmail).mockResolvedValue(buildUser({ passwordHash }) as never);

    const result = await authService.login('staff@potatocorner.test', 'CorrectHorse1', 'device-1', '127.0.0.1');

    expect(result.access_token).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(authRepository.storeRefreshToken).toHaveBeenCalledWith('user-1', result.refreshToken, 'device-1', expect.any(Date));
    expect(authRepository.resetLoginAttempts).toHaveBeenCalledWith('user-1');
  });

  it('increments the login attempt counter on wrong password', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorse1', 12);
    vi.mocked(authRepository.findUserByEmail).mockResolvedValue(buildUser({ passwordHash }) as never);

    await expect(authService.login('staff@potatocorner.test', 'WrongPassword', 'device-1', null)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });

    expect(authRepository.incrementLoginAttempts).toHaveBeenCalledWith('user-1');
  });

  it('returns ACCOUNT_LOCKED after the account is already locked', async () => {
    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    vi.mocked(authRepository.findUserByEmail).mockResolvedValue(buildUser({ loginAttempts: 5, lockedUntil }) as never);

    await expect(authService.login('staff@potatocorner.test', 'anything', 'device-1', null)).rejects.toMatchObject({
      code: 'ACCOUNT_LOCKED',
      statusCode: 423,
    });
    expect(authRepository.incrementLoginAttempts).not.toHaveBeenCalled();
  });

  it('auto-unlocks the account once the lockout window has passed', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorse1', 12);
    const lockedUntil = new Date(Date.now() - 60 * 1000); // already expired
    vi.mocked(authRepository.findUserByEmail).mockResolvedValue(
      buildUser({ passwordHash, loginAttempts: 5, lockedUntil }) as never,
    );

    const result = await authService.login('staff@potatocorner.test', 'CorrectHorse1', 'device-1', null);

    expect(authRepository.resetLoginAttempts).toHaveBeenCalledWith('user-1');
    expect(result.access_token).toEqual(expect.any(String));
  });
});

describe('authService.refreshToken', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const storedToken = {
      id: 'rt-1',
      userId: 'user-1',
      deviceId: 'device-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      user: buildUser(),
    };
    vi.mocked(authRepository.findRefreshToken).mockResolvedValue(storedToken as never);
    vi.mocked(authRepository.rotateRefreshToken).mockResolvedValue({ id: 'rt-2' } as never);

    const result = await authService.refreshToken('old-refresh-token', 'device-1');

    expect(authRepository.rotateRefreshToken).toHaveBeenCalledWith('rt-1', expect.any(String), expect.any(Date));
    expect(result.access_token).toEqual(expect.any(String));
  });

  it('rejects an invalid or missing refresh token with 401', async () => {
    vi.mocked(authRepository.findRefreshToken).mockResolvedValue(null);

    await expect(authService.refreshToken('bogus-token', 'device-1')).rejects.toMatchObject({
      code: 'REFRESH_INVALID',
      statusCode: 401,
    });
  });
});

describe('authService.logout', () => {
  it('blacklists the access token in Redis', async () => {
    const accessToken = authService.generateAccessToken({
      id: 'user-1',
      role: ROLES.STAFF,
      email: 'staff@potatocorner.test',
      branchIds: ['branch-1'],
    });
    vi.mocked(authRepository.findRefreshToken).mockResolvedValue(null);

    await authService.logout(accessToken, undefined);

    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining('auth:blacklist:'), '1', 'EX', expect.any(Number));
  });
});

describe('authService.changePassword', () => {
  it('blacklists all existing tokens, clears must_change_password, and issues a fresh token pair', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorse1', 12);
    vi.mocked(authRepository.findUserWithPasswordById).mockResolvedValue(buildUser({ passwordHash }) as never);
    vi.mocked(authRepository.findUserById).mockResolvedValue(buildUser({ mustChangePassword: false }) as never);

    const accessToken = authService.generateAccessToken({
      id: 'user-1',
      role: ROLES.STAFF,
      email: 'staff@potatocorner.test',
      branchIds: ['branch-1'],
      mustChangePassword: true,
    });

    const result = await authService.changePassword('user-1', 'CorrectHorse1', 'NewPassword1', accessToken, 'device-1');

    expect(authRepository.setMustChangePassword).toHaveBeenCalledWith('user-1', false);
    expect(authRepository.revokeAllUserTokens).toHaveBeenCalledWith('user-1');
    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining('auth:blacklist:'), '1', 'EX', expect.any(Number));
    expect(result.access_token).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(authRepository.storeRefreshToken).toHaveBeenCalledWith('user-1', result.refreshToken, 'device-1', expect.any(Date));
  });
});

describe('generateAccessToken payload structure', () => {
  it('produces a Super Admin token with no branch_ids field', () => {
    const token = authService.generateAccessToken({
      id: 'admin-1',
      role: ROLES.SUPER_ADMIN,
      email: 'admin@potatocorner.test',
      branchIds: [],
    });
    const decoded = jwt.verify(token, config.jwt.publicKey, { algorithms: ['RS256'] }) as Record<string, unknown>;

    expect(decoded).toMatchObject({ user_id: 'admin-1', role: 'super_admin', email: 'admin@potatocorner.test' });
    expect(decoded).not.toHaveProperty('branch_ids');
    expect(decoded).toHaveProperty('iat');
    expect(decoded).toHaveProperty('exp');
  });

  it('produces a Supervisor token with a branch_ids array', () => {
    const token = authService.generateAccessToken({
      id: 'sup-1',
      role: ROLES.SUPERVISOR,
      email: 'supervisor@potatocorner.test',
      branchIds: ['branch-1', 'branch-2'],
    });
    const decoded = jwt.verify(token, config.jwt.publicKey, { algorithms: ['RS256'] }) as Record<string, unknown>;

    expect(decoded.branch_ids).toEqual(['branch-1', 'branch-2']);
  });

  it('produces a Staff token with a single-entry branch_ids array', () => {
    const token = authService.generateAccessToken({
      id: 'staff-1',
      role: ROLES.STAFF,
      email: 'staff@potatocorner.test',
      branchIds: ['branch-1'],
    });
    const decoded = jwt.verify(token, config.jwt.publicKey, { algorithms: ['RS256'] }) as Record<string, unknown>;

    expect(decoded.branch_ids).toEqual(['branch-1']);
  });
});
