import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import { ROLES, SOCKET_EVENTS } from '@potato-corner/shared';

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    revokedToken: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../modules/branches/branches.repository.js', () => ({
  branchesRepository: {
    findAllActiveBranchIds: vi.fn(),
  },
}));

const { prisma } = await import('../lib/prisma.js');
const { branchesRepository } = await import('../modules/branches/branches.repository.js');
const { revokedTokenHash } = await import('../lib/verify-access-token.js');
const { socketAuthMiddleware, joinRoomsForUser } = await import('./socket.server.js');
const { SUPER_ADMIN_ROOM, branchRoom, userRoom } = await import('./rooms.js');
const { generateStaffToken, generateSuperAdminToken } = await import('../test-utils/auth-tokens.js');

/** Minimal fake Socket — only the handshake/data surface socketAuthMiddleware touches. */
function mockSocket(overrides: { auth?: Record<string, unknown>; headers?: Record<string, string> } = {}): Socket {
  return {
    handshake: { auth: overrides.auth ?? {}, headers: overrides.headers ?? {} },
    data: {},
  } as unknown as Socket;
}

/** Minimal fake Socket for joinRoomsForUser — only the `join` call it makes. */
function mockJoinableSocket(): { join: ReturnType<typeof vi.fn> } {
  return { join: vi.fn() };
}

/** JwtPayload requires iat/exp — irrelevant to room assignment, so a fixed pair covers every test. */
const IAT_EXP = { iat: 0, exp: 0 };

beforeEach(() => {
  vi.mocked(prisma.revokedToken.findFirst).mockReset();
  vi.mocked(prisma.revokedToken.findFirst).mockResolvedValue(null);
  vi.mocked(branchesRepository.findAllActiveBranchIds).mockReset();
});

describe('socketAuthMiddleware', () => {
  it('accepts a validly signed token via handshake.auth.token and populates socket.data.user', async () => {
    const staffUserId = randomUUID();
    const branchId = randomUUID();
    const token = generateStaffToken(branchId, { userId: staffUserId, email: 'staff@potatocorner.test' });
    const socket = mockSocket({ auth: { token } });
    const next = vi.fn();

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user).toMatchObject({ user_id: staffUserId, role: ROLES.STAFF, branch_ids: [branchId] });
  });

  it('falls back to the Authorization header when handshake.auth.token is absent', async () => {
    const staffUserId = randomUUID();
    const branchId = randomUUID();
    const token = generateStaffToken(branchId, { userId: staffUserId });
    const socket = mockSocket({ headers: { authorization: `Bearer ${token}` } });
    const next = vi.fn();

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user).toMatchObject({ user_id: staffUserId, role: ROLES.STAFF });
  });

  it('rejects a connection with no token at all — "Authentication required"', async () => {
    const socket = mockSocket();
    const next = vi.fn();

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Authentication required' }));
    expect(socket.data.user).toBeUndefined();
  });

  it('rejects a malformed (non-JWT) token — "Invalid token format"', async () => {
    const socket = mockSocket({ auth: { token: 'not-a-real-jwt' } });
    const next = vi.fn();

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid token format' }));
    expect(socket.data.user).toBeUndefined();
  });

  it('rejects a token signed with the wrong private key — "Invalid token signature"', async () => {
    const { privateKey: wrongPrivateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const token = jwt.sign(
      { user_id: randomUUID(), role: ROLES.SUPER_ADMIN, email: 'forged@potatocorner.test' },
      wrongPrivateKey,
      { algorithm: 'RS256', expiresIn: '15m' },
    );
    const socket = mockSocket({ auth: { token } });
    const next = vi.fn();

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid token signature' }));
    expect(socket.data.user).toBeUndefined();
  });

  it('rejects an expired token — "Token expired"', async () => {
    const token = generateSuperAdminToken({ expired: true });
    const socket = mockSocket({ auth: { token } });
    const next = vi.fn();

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Token expired' }));
    expect(socket.data.user).toBeUndefined();
  });

  it('rejects a blacklisted token — "Token revoked"', async () => {
    const token = generateSuperAdminToken();
    vi.mocked(prisma.revokedToken.findFirst).mockImplementation((async (args: { where: { tokenHash: string } }) =>
      args.where.tokenHash === revokedTokenHash(token) ? { id: 'revoked-1' } : null) as never);
    const socket = mockSocket({ auth: { token } });
    const next = vi.fn();

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Token revoked' }));
    expect(socket.data.user).toBeUndefined();
  });

  it('rejects a forged base64 JSON payload — the identity-spoofing bypass this module fixes', async () => {
    // Exactly the shape the old vulnerable code trusted: a base64-encoded
    // JSON blob claiming Super Admin, with no signature at all.
    const forged = Buffer.from(
      JSON.stringify({ user_id: randomUUID(), role: ROLES.SUPER_ADMIN, email: 'attacker@potatocorner.test' }),
    ).toString('base64');
    const socket = mockSocket({ auth: { token: forged } });
    const next = vi.fn();

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next).not.toHaveBeenCalledWith();
    expect(socket.data.user).toBeUndefined();
  });
});

describe('joinRoomsForUser', () => {
  it('joins a staff connection to its own user room and its single assigned branch room, and no other room', async () => {
    const userId = randomUUID();
    const branchId = randomUUID();
    const socket = mockJoinableSocket();

    await joinRoomsForUser(socket, { ...IAT_EXP, user_id: userId, role: ROLES.STAFF, email: 'staff@potatocorner.test', branch_ids: [branchId] });

    expect(socket.join).toHaveBeenCalledTimes(2);
    expect(socket.join).toHaveBeenCalledWith(userRoom(userId));
    expect(socket.join).toHaveBeenCalledWith(branchRoom(branchId));
    expect(socket.join).not.toHaveBeenCalledWith(SUPER_ADMIN_ROOM);
    expect(branchesRepository.findAllActiveBranchIds).not.toHaveBeenCalled();
  });

  // Supervisor rooms are resolved from the database's active-branch list
  // (findAllActiveBranchIds), never the JWT's branch_ids claim — this keeps
  // real-time delivery aligned with the same organization-wide, active-only
  // access rule the REST API enforces via getAccessibleBranchIds.
  it('joins a supervisor connection to its own user room and every currently-active branch room', async () => {
    const userId = randomUUID();
    const branchA = randomUUID();
    const branchB = randomUUID();
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([branchA, branchB]);
    const socket = mockJoinableSocket();

    await joinRoomsForUser(socket, { ...IAT_EXP, user_id: userId, role: ROLES.SUPERVISOR, email: 'supervisor@potatocorner.test', branch_ids: [] });

    expect(socket.join).toHaveBeenCalledWith(userRoom(userId));
    expect(socket.join).toHaveBeenCalledWith(branchRoom(branchA));
    expect(socket.join).toHaveBeenCalledWith(branchRoom(branchB));
    expect(socket.join).toHaveBeenCalledTimes(3);
  });

  it('joins a supervisor to an active branch even when absent from their (stale) JWT branch_ids', async () => {
    const userId = randomUUID();
    const branchA = randomUUID();
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([branchA]);
    const socket = mockJoinableSocket();

    await joinRoomsForUser(socket, { ...IAT_EXP, user_id: userId, role: ROLES.SUPERVISOR, email: 'supervisor@potatocorner.test', branch_ids: [] });

    expect(socket.join).toHaveBeenCalledWith(branchRoom(branchA));
  });

  it('joins a super_admin connection to its own user room and the Super Admin room only, never a branch room', async () => {
    const userId = randomUUID();
    const socket = mockJoinableSocket();

    await joinRoomsForUser(socket, { ...IAT_EXP, user_id: userId, role: ROLES.SUPER_ADMIN, email: 'admin@potatocorner.test' });

    expect(socket.join).toHaveBeenCalledTimes(2);
    expect(socket.join).toHaveBeenCalledWith(userRoom(userId));
    expect(socket.join).toHaveBeenCalledWith(SUPER_ADMIN_ROOM);
    expect(branchesRepository.findAllActiveBranchIds).not.toHaveBeenCalled();
  });

  it('room isolation — a staff connection for branch A never joins branch B\'s room', async () => {
    const branchA = randomUUID();
    const branchB = randomUUID();
    const socket = mockJoinableSocket();

    await joinRoomsForUser(socket, { ...IAT_EXP, user_id: randomUUID(), role: ROLES.STAFF, email: 'staff@potatocorner.test', branch_ids: [branchA] });

    expect(socket.join).not.toHaveBeenCalledWith(branchRoom(branchB));
  });
});

describe('SOCKET_EVENTS shape', () => {
  it('every event name is a unique, colon-namespaced string — the contract services must follow instead of inventing string literals', () => {
    const names = Object.values(SOCKET_EVENTS);
    const uniqueNames = new Set(names);

    expect(uniqueNames.size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });
});
