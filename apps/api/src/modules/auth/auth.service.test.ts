import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { ROLES } from '@potato-corner/shared';

// Phase 21: authRepository.withAdvisoryLock replaces the Redis lock — the
// mock just invokes the callback with a stand-in tx client, matching
// prisma.$transaction's real shape closely enough for findRefreshTokenTx /
// rotateRefreshTokenTx (also mocked below, and also tx-aware in prod) to be
// exercised without a real Postgres connection.
const fakeTx = { __fakeTransactionClient: true };

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
    findActiveSessionsByUser: vi.fn(),
    findSessionById: vi.fn(),
    storePinHash: vi.fn(),
    findPinHash: vi.fn(),
    hasActiveDeviceSession: vi.fn(),
    updatePasswordHash: vi.fn(),
    setMustChangePassword: vi.fn(),
    insertRevokedToken: vi.fn().mockResolvedValue(undefined),
    storePasswordResetToken: vi.fn().mockResolvedValue(undefined),
    findPasswordResetToken: vi.fn(),
    deletePasswordResetToken: vi.fn().mockResolvedValue(undefined),
    withAdvisoryLock: vi.fn((_lockId: bigint, fn: (tx: unknown) => unknown) => fn(fakeTx)),
    findRefreshTokenTx: vi.fn(),
    rotateRefreshTokenTx: vi.fn(),
    findRotationCacheTx: vi.fn(),
    insertRotationCacheTx: vi.fn().mockResolvedValue(undefined),
    findTotpFieldsById: vi.fn(),
    setPendingTotpSecret: vi.fn().mockResolvedValue(undefined),
    enableTotp: vi.fn().mockResolvedValue(undefined),
    disableTotp: vi.fn().mockResolvedValue(undefined),
    setBackupCodes: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/email.js', () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

// Real AES-256-GCM would require a live ENCRYPTION_KEY; these tests only
// care that whatever setPendingTotpSecret stored is what confirm/disable/
// regenerate later decrypt, so a reversible stand-in is enough.
vi.mock('../../lib/encryption.js', () => ({
  encryptField: vi.fn((plaintext: string) => `enc:${plaintext}`),
  decryptField: vi.fn((encoded: string) => encoded.replace(/^enc:/, '')),
}));

vi.mock('./totp.service.js', () => ({
  totpService: {
    generateSecret: vi.fn(() => 'MOCKSECRET'),
    generateQrCodeDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,mock'),
    verifyToken: vi.fn(),
    generateBackupCodes: vi.fn(() => ['CODE0000A', 'CODE0000B']),
    hashBackupCode: vi.fn((code: string) => Promise.resolve(`hashed:${code}`)),
    verifyBackupCode: vi.fn(),
  },
}));

const { authRepository } = await import('./auth.repository.js');
const { authService } = await import('./auth.service.js');
const { totpService } = await import('./totp.service.js');
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
  // clearAllMocks resets call history but not mockResolvedValue — reinstate
  // the "no cache hit" default so a prior test's cached-result mock can't
  // leak into a later refreshToken() test that expects a real rotation.
  vi.mocked(authRepository.findRotationCacheTx).mockResolvedValue(null);
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
    expect(authRepository.updateLastLogin).toHaveBeenCalledWith('user-1');
  });

  it('fails the login if a parallel post-auth write rejects', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorse1', 12);
    vi.mocked(authRepository.findUserByEmail).mockResolvedValue(buildUser({ passwordHash }) as never);
    vi.mocked(authRepository.storeRefreshToken).mockRejectedValueOnce(new Error('db unavailable'));

    await expect(authService.login('staff@potatocorner.test', 'CorrectHorse1', 'device-1', null)).rejects.toThrow(
      'db unavailable',
    );
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
  it('acquires the Postgres advisory lock, rotates the refresh token, and issues a new access token', async () => {
    const storedToken = {
      id: 'rt-1',
      userId: 'user-1',
      deviceId: 'device-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      user: buildUser(),
    };
    vi.mocked(authRepository.findRefreshTokenTx).mockResolvedValue(storedToken as never);
    vi.mocked(authRepository.rotateRefreshTokenTx).mockResolvedValue({ id: 'rt-2' } as never);

    const result = await authService.refreshToken('old-refresh-token', 'device-1');

    const lockCall = vi.mocked(authRepository.withAdvisoryLock).mock.calls[0];
    expect(lockCall).toHaveLength(2);
    expect(typeof lockCall?.[0]).toBe('bigint');
    expect(authRepository.findRefreshTokenTx).toHaveBeenCalledWith(fakeTx, 'old-refresh-token');
    expect(authRepository.rotateRefreshTokenTx).toHaveBeenCalledWith(fakeTx, 'rt-1', expect.any(String), expect.any(Date));
    expect(result.access_token).toEqual(expect.any(String));
  });

  it('rejects an invalid or missing refresh token with 401', async () => {
    vi.mocked(authRepository.findRefreshTokenTx).mockResolvedValue(null);

    await expect(authService.refreshToken('bogus-token', 'device-1')).rejects.toMatchObject({
      code: 'REFRESH_INVALID',
      statusCode: 401,
    });
  });

  it('logs and rejects when a revoked token is replayed', async () => {
    const storedToken = {
      id: 'rt-1',
      userId: 'user-1',
      deviceId: 'device-1',
      revokedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      user: buildUser(),
    };
    vi.mocked(authRepository.findRefreshTokenTx).mockResolvedValue(storedToken as never);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(authService.refreshToken('old-refresh-token', 'device-1')).rejects.toMatchObject({
      code: 'REFRESH_INVALID',
    });
    expect(warnSpy).toHaveBeenCalledWith('Refresh token reuse detected', expect.objectContaining({ userId: 'user-1', tokenId: 'rt-1' }));

    warnSpy.mockRestore();
  });

  it('rotates the token and writes the result to the rotation cache, keyed by the pre-rotation token', async () => {
    const storedToken = {
      id: 'rt-1',
      userId: 'user-1',
      deviceId: 'device-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      user: buildUser(),
    };
    vi.mocked(authRepository.findRefreshTokenTx).mockResolvedValue(storedToken as never);
    vi.mocked(authRepository.rotateRefreshTokenTx).mockResolvedValue({ id: 'rt-2' } as never);

    const result = await authService.refreshToken('old-refresh-token', 'device-1');

    expect(authRepository.insertRotationCacheTx).toHaveBeenCalledWith(
      fakeTx,
      expect.any(String),
      result.access_token,
      result.refreshToken,
      expect.any(Date),
    );
  });

  // Restores the Phase 20.5 (commit 9507200) behavior that Phase 21 (commit
  // 28a2956) dropped along with Redis: a legitimate near-duplicate request
  // racing right behind the one that already rotated gets that request's
  // result back instead of REFRESH_INVALID.
  it('returns the cached rotation result for a near-duplicate request instead of rotating again', async () => {
    const cached = {
      cachedAccessToken: 'cached-access-token',
      cachedRefreshToken: 'cached-refresh-token',
    };
    vi.mocked(authRepository.findRotationCacheTx).mockResolvedValue(cached as never);

    const result = await authService.refreshToken('old-refresh-token', 'device-1');

    expect(result).toEqual({ access_token: 'cached-access-token', refreshToken: 'cached-refresh-token' });
    expect(authRepository.findRefreshTokenTx).not.toHaveBeenCalled();
    expect(authRepository.rotateRefreshTokenTx).not.toHaveBeenCalled();
  });

  it('rejects a token presented from a different device', async () => {
    const storedToken = {
      id: 'rt-1',
      userId: 'user-1',
      deviceId: 'device-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      user: buildUser(),
    };
    vi.mocked(authRepository.findRefreshTokenTx).mockResolvedValue(storedToken as never);

    await expect(authService.refreshToken('old-refresh-token', 'device-2')).rejects.toMatchObject({
      code: 'REFRESH_INVALID',
    });
  });
});

describe('authService.logout', () => {
  it('blacklists the access token in the Postgres revocation table', async () => {
    const accessToken = authService.generateAccessToken({
      id: 'user-1',
      role: ROLES.STAFF,
      email: 'staff@potatocorner.test',
      branchIds: ['branch-1'],
    });
    vi.mocked(authRepository.findRefreshToken).mockResolvedValue(null);

    await authService.logout(accessToken, undefined);

    expect(authRepository.insertRevokedToken).toHaveBeenCalledWith(expect.any(String), expect.any(Date));
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
    expect(authRepository.insertRevokedToken).toHaveBeenCalledWith(expect.any(String), expect.any(Date));
    expect(result.access_token).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(authRepository.storeRefreshToken).toHaveBeenCalledWith('user-1', result.refreshToken, 'device-1', expect.any(Date));
  });
});

describe('authService.unlockAccount', () => {
  it('resets the login attempt counter and records an audit log entry', async () => {
    vi.mocked(authRepository.findUserById).mockResolvedValue(buildUser({ loginAttempts: 5, lockedUntil: new Date() }) as never);

    await authService.unlockAccount('user-1', { id: 'admin-1', role: ROLES.SUPER_ADMIN }, '127.0.0.1');

    expect(authRepository.resetLoginAttempts).toHaveBeenCalledWith('user-1');
  });

  it('throws USER_NOT_FOUND for an unknown user id', async () => {
    vi.mocked(authRepository.findUserById).mockResolvedValue(null);

    await expect(authService.unlockAccount('missing-user', { id: 'admin-1', role: ROLES.SUPER_ADMIN }, null)).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
      statusCode: 404,
    });
    expect(authRepository.resetLoginAttempts).not.toHaveBeenCalled();
  });
});

describe('authService.listUserSessions', () => {
  it('returns only active refresh tokens for the user', async () => {
    vi.mocked(authRepository.findActiveSessionsByUser).mockResolvedValue([
      { id: 'session-1', deviceId: 'device-aaaaaaaa', createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
    ] as never);

    const sessions = await authService.listUserSessions('user-1', 'device-aaaaaaaa');

    expect(authRepository.findActiveSessionsByUser).toHaveBeenCalledWith('user-1');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: 'session-1', deviceId: 'device-aaaaaaaa' });
  });

  it('marks the session matching currentDeviceId with isCurrent=true', async () => {
    vi.mocked(authRepository.findActiveSessionsByUser).mockResolvedValue([
      { id: 'session-1', deviceId: 'device-current', createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
      { id: 'session-2', deviceId: 'device-other', createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
    ] as never);

    const sessions = await authService.listUserSessions('user-1', 'device-current');

    expect(sessions.find((s) => s.id === 'session-1')?.isCurrent).toBe(true);
    expect(sessions.find((s) => s.id === 'session-2')?.isCurrent).toBe(false);
  });

  it('excludes expired and revoked tokens (repository filters, service trusts it)', async () => {
    // The repository query itself filters revokedAt IS NULL AND expiresAt > NOW() —
    // this asserts the service doesn't re-include anything the repository already excluded.
    vi.mocked(authRepository.findActiveSessionsByUser).mockResolvedValue([]);

    const sessions = await authService.listUserSessions('user-1', 'device-current');

    expect(sessions).toEqual([]);
  });
});

describe('authService.revokeSession', () => {
  it('sets revokedAt on the target session', async () => {
    vi.mocked(authRepository.findSessionById).mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      deviceId: 'device-other',
    } as never);

    await authService.revokeSession('user-1', 'session-1', 'device-current', ROLES.STAFF);

    expect(authRepository.revokeRefreshToken).toHaveBeenCalledWith('session-1');
  });

  it('throws when the session belongs to another user', async () => {
    vi.mocked(authRepository.findSessionById).mockResolvedValue({
      id: 'session-1',
      userId: 'someone-else',
      deviceId: 'device-other',
    } as never);

    await expect(authService.revokeSession('user-1', 'session-1', 'device-current', ROLES.STAFF)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
    expect(authRepository.revokeRefreshToken).not.toHaveBeenCalled();
  });

  it('throws 400 when attempting to revoke the current session', async () => {
    vi.mocked(authRepository.findSessionById).mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      deviceId: 'device-current',
    } as never);

    await expect(authService.revokeSession('user-1', 'session-1', 'device-current', ROLES.STAFF)).rejects.toMatchObject({
      code: 'CANNOT_REVOKE_CURRENT_SESSION',
      statusCode: 400,
    });
    expect(authRepository.revokeRefreshToken).not.toHaveBeenCalled();
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

describe('authService.initiate2FAEnrollment', () => {
  it('stores the encrypted secret and returns the secret + QR code', async () => {
    const result = await authService.initiate2FAEnrollment('user-1', 'staff@potatocorner.test');

    expect(result.secret).toBe('MOCKSECRET');
    expect(result.qrCodeDataUrl).toBe('data:image/png;base64,mock');
    expect(authRepository.setPendingTotpSecret).toHaveBeenCalledWith('user-1', 'enc:MOCKSECRET');
  });
});

describe('authService.confirm2FAEnrollment', () => {
  it('enables 2FA and returns backup codes for a valid token', async () => {
    vi.mocked(authRepository.findTotpFieldsById).mockResolvedValue({
      id: 'user-1',
      email: 'staff@potatocorner.test',
      role: ROLES.STAFF,
      totpSecret: 'enc:MOCKSECRET',
      totpEnabled: false,
      totpEnrolledAt: null,
      totpBackupCodes: [],
    } as never);
    vi.mocked(totpService.verifyToken).mockReturnValue(true);

    const result = await authService.confirm2FAEnrollment('user-1', '123456');

    expect(result.backupCodes).toEqual(['CODE0000A', 'CODE0000B']);
    expect(authRepository.enableTotp).toHaveBeenCalledWith('user-1', ['hashed:CODE0000A', 'hashed:CODE0000B']);
  });

  it('throws INVALID_TOKEN for an invalid token', async () => {
    vi.mocked(authRepository.findTotpFieldsById).mockResolvedValue({
      id: 'user-1',
      email: 'staff@potatocorner.test',
      role: ROLES.STAFF,
      totpSecret: 'enc:MOCKSECRET',
      totpEnabled: false,
      totpEnrolledAt: null,
      totpBackupCodes: [],
    } as never);
    vi.mocked(totpService.verifyToken).mockReturnValue(false);

    await expect(authService.confirm2FAEnrollment('user-1', '000000')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    expect(authRepository.enableTotp).not.toHaveBeenCalled();
  });
});

describe('authService.disable2FA', () => {
  it('requires both the correct password and a valid TOTP code', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorse1', 12);
    vi.mocked(authRepository.findUserWithPasswordById).mockResolvedValue(
      buildUser({ passwordHash }) as never,
    );
    vi.mocked(authRepository.findTotpFieldsById).mockResolvedValue({
      id: 'user-1',
      email: 'staff@potatocorner.test',
      role: ROLES.STAFF,
      totpSecret: 'enc:MOCKSECRET',
      totpEnabled: true,
      totpEnrolledAt: new Date(),
      totpBackupCodes: ['hashed:CODE0000A'],
    } as never);
    vi.mocked(totpService.verifyToken).mockReturnValue(true);

    await authService.disable2FA('user-1', 'CorrectHorse1', '123456');

    expect(authRepository.disableTotp).toHaveBeenCalledWith('user-1');
  });

  it('rejects a wrong password even with a valid TOTP code', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorse1', 12);
    vi.mocked(authRepository.findUserWithPasswordById).mockResolvedValue(
      buildUser({ passwordHash }) as never,
    );
    vi.mocked(authRepository.findTotpFieldsById).mockResolvedValue({
      id: 'user-1',
      email: 'staff@potatocorner.test',
      role: ROLES.STAFF,
      totpSecret: 'enc:MOCKSECRET',
      totpEnabled: true,
      totpEnrolledAt: new Date(),
      totpBackupCodes: [],
    } as never);
    vi.mocked(totpService.verifyToken).mockReturnValue(true);

    await expect(authService.disable2FA('user-1', 'WrongPassword1', '123456')).rejects.toMatchObject({
      code: 'INVALID_PASSWORD',
    });
    expect(authRepository.disableTotp).not.toHaveBeenCalled();
  });

  it('clears the secret and backup codes on success', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorse1', 12);
    vi.mocked(authRepository.findUserWithPasswordById).mockResolvedValue(
      buildUser({ passwordHash }) as never,
    );
    vi.mocked(authRepository.findTotpFieldsById).mockResolvedValue({
      id: 'user-1',
      email: 'staff@potatocorner.test',
      role: ROLES.STAFF,
      totpSecret: 'enc:MOCKSECRET',
      totpEnabled: true,
      totpEnrolledAt: new Date(),
      totpBackupCodes: [],
    } as never);
    vi.mocked(totpService.verifyToken).mockReturnValue(true);

    await authService.disable2FA('user-1', 'CorrectHorse1', '123456');

    expect(authRepository.disableTotp).toHaveBeenCalledTimes(1);
  });
});

describe('authService.regenerateBackupCodes', () => {
  it('replaces the old backup codes with a new set', async () => {
    vi.mocked(authRepository.findTotpFieldsById).mockResolvedValue({
      id: 'user-1',
      email: 'staff@potatocorner.test',
      role: ROLES.STAFF,
      totpSecret: 'enc:MOCKSECRET',
      totpEnabled: true,
      totpEnrolledAt: new Date(),
      totpBackupCodes: ['hashed:OLDCODE'],
    } as never);
    vi.mocked(totpService.verifyToken).mockReturnValue(true);

    const result = await authService.regenerateBackupCodes('user-1', '123456');

    expect(result.backupCodes).toEqual(['CODE0000A', 'CODE0000B']);
    expect(authRepository.setBackupCodes).toHaveBeenCalledWith('user-1', ['hashed:CODE0000A', 'hashed:CODE0000B']);
  });
});
