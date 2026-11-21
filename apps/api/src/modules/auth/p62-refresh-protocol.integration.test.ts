import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P62 — the refresh-token protocol against a real Postgres and the real
 * Express app over HTTP: a lost response on the same device, concurrent tabs,
 * revoked sessions, logout from a stale cookie, another device, expiry, a real
 * replay and the end of the grace period.
 *
 * Requires TEST_DATABASE_URL pointing at a disposable, migrated database.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { authRepository, ROTATION_GRACE_MS } = await import('./auth.repository.js');
const { authService } = await import('./auth.service.js');
const { sha256Hex, randomOpaqueToken } = await import('../../lib/hash.js');

describe.skipIf(!canRunIntegrationTests)('P62 refresh protocol', () => {
  let server: Server;
  let baseUrl: string;
  const userIds: string[] = [];
  const presentedHashes: string[] = [];

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await prisma.refreshTokenRotationCache.deleteMany({ where: { originalTokenHash: { in: presentedHashes } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function session(options: { expiresInMs?: number } = {}) {
    const user = await prisma.user.create({
      data: { email: `p62-${randomUUID().slice(0, 8)}@potatocorner.test`, passwordHash: 'unused', role: 'supervisor', firstName: 'P62', lastName: 'Refresh', employmentType: 'regular', mustChangePassword: false },
    });
    userIds.push(user.id);
    const deviceId = randomUUID();
    const token = randomOpaqueToken();
    await authRepository.storeRefreshToken(user.id, token, deviceId, new Date(Date.now() + (options.expiresInMs ?? 3_600_000)));
    return { userId: user.id, deviceId, token };
  }

  async function refresh(token: string, deviceId: string) {
    presentedHashes.push(sha256Hex(token));
    const response = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `refresh_token=${token}` },
      body: JSON.stringify({ device_id: deviceId }),
    });
    const body = (await response.json()) as { data: { access_token: string } | null; error: { code: string } | null };
    const setCookies = response.headers.getSetCookie();
    const valueOf = (name: string) => {
      const cookie = setCookies.find((value) => value.startsWith(`${name}=`));
      return cookie === undefined ? undefined : decodeURIComponent(cookie.slice(name.length + 1).split(';')[0] ?? '');
    };
    const next = valueOf('refresh_token') || null;
    // An empty value is how res.clearCookie removes a cookie.
    const cleared = valueOf('refresh_token') === '' && valueOf('pc_access_hint') === '';
    return { status: response.status, code: body.error?.code ?? null, accessToken: body.data?.access_token ?? null, next, cleared };
  }

  async function liveTokens(userId: string) {
    return prisma.refreshToken.findMany({ where: { userId, revokedAt: null } });
  }

  it('same device, lost response: the old token gets the same successor back, and the chain continues', async () => {
    const s = await session();
    const first = await refresh(s.token, s.deviceId);
    expect(first.status).toBe(200);
    // The browser never saw `first`. It presents the old token again.
    const again = await refresh(s.token, s.deviceId);
    expect(again).toMatchObject({ status: 200, next: first.next });
    expect(again.accessToken).toEqual(expect.any(String));
    expect(await liveTokens(s.userId)).toHaveLength(1);
    const onward = await refresh(again.next ?? '', s.deviceId);
    expect(onward.status).toBe(200);
    expect(onward.next).not.toBe(first.next);
  });

  it('concurrent tabs presenting one token all get the same successor; one live token remains', async () => {
    const s = await session();
    const results = await Promise.all(Array.from({ length: 6 }, () => refresh(s.token, s.deviceId)));
    expect(results.map((result) => result.status)).toEqual(Array(6).fill(200));
    expect(new Set(results.map((result) => result.next)).size).toBe(1);
    expect(await liveTokens(s.userId)).toHaveLength(1);
  });

  it('a revoked session gets nothing from the grace period', async () => {
    const s = await session();
    expect((await refresh(s.token, s.deviceId)).status).toBe(200);
    await authRepository.revokeAllUserTokens(s.userId);
    expect(await refresh(s.token, s.deviceId)).toMatchObject({ status: 401, code: 'REFRESH_INVALID', next: null });
  });

  it('a session that is over loses its cookies, so /login is not routed from a stale access hint', async () => {
    // Found in the P62 browser run: cookies restored after logout kept the web
    // middleware sending /login back to the dashboard until the hint expired.
    const s = await session();
    await authRepository.revokeAllUserTokens(s.userId);
    expect(await refresh(s.token, s.deviceId)).toMatchObject({ status: 401, code: 'REFRESH_INVALID', cleared: true });
    const missing = await fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_id: s.deviceId }) });
    expect(missing.status).toBe(401);
    expect(missing.headers.getSetCookie().some((value) => value.startsWith('pc_access_hint=;'))).toBe(true);
    // A successful refresh sets both, never clears.
    const live = await session();
    expect(await refresh(live.token, live.deviceId)).toMatchObject({ status: 200, cleared: false });
  });

  it('logout from a stale cookie ends the live successor too', async () => {
    const s = await session();
    const lost = await refresh(s.token, s.deviceId);
    expect(lost.status).toBe(200);
    const accessToken = lost.accessToken ?? '';
    const response = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, cookie: `refresh_token=${s.token}; csrf-token=p62`, 'x-csrf-token': 'p62', 'x-device-id': s.deviceId },
    });
    expect(response.status).toBe(200);
    expect(await liveTokens(s.userId)).toHaveLength(0);
    expect((await refresh(s.token, s.deviceId)).status).toBe(401);
    expect((await refresh(lost.next ?? '', s.deviceId)).status).toBe(401);
    // The access token used for logout is revoked as well.
    const after = await fetch(`${baseUrl}/api/auth/sessions`, { headers: { authorization: `Bearer ${accessToken}`, 'x-device-id': s.deviceId } });
    expect(after.status).toBe(401);
  });

  it('another device can neither refresh the token nor collect a cached successor, and the owner is unaffected', async () => {
    const s = await session();
    expect(await refresh(s.token, randomUUID())).toMatchObject({ status: 401, code: 'REFRESH_INVALID' });
    const own = await refresh(s.token, s.deviceId);
    expect(own.status).toBe(200);
    expect(await refresh(s.token, randomUUID())).toMatchObject({ status: 401, next: null });
    expect((await refresh(own.next ?? '', s.deviceId)).status).toBe(200);
  });

  it('an expired token is refused', async () => {
    const s = await session({ expiresInMs: -1000 });
    expect(await refresh(s.token, s.deviceId)).toMatchObject({ status: 401, code: 'REFRESH_INVALID' });
  });

  it('a real replay (the successor was already used) revokes the device session', async () => {
    const s = await session();
    const second = await refresh(s.token, s.deviceId);
    const third = await refresh(second.next ?? '', s.deviceId);
    expect(third.status).toBe(200);
    expect(await refresh(s.token, s.deviceId)).toMatchObject({ status: 401, code: 'REFRESH_INVALID' });
    expect(await liveTokens(s.userId)).toHaveLength(0);
    expect((await refresh(third.next ?? '', s.deviceId)).status).toBe(401);
  });

  it('after the grace period the old token is a replay, even with its successor unused', async () => {
    const s = await session();
    const lost = await refresh(s.token, s.deviceId);
    await prisma.refreshTokenRotationCache.update({ where: { originalTokenHash: sha256Hex(s.token) }, data: { createdAt: new Date(Date.now() - ROTATION_GRACE_MS - 1000) } });
    expect((await refresh(s.token, s.deviceId)).status).toBe(401);
    expect((await refresh(lost.next ?? '', s.deviceId)).status).toBe(401);
  });

  it('a deactivated user cannot refresh, inside or outside the grace period', async () => {
    const s = await session();
    expect((await refresh(s.token, s.deviceId)).status).toBe(200);
    await prisma.user.update({ where: { id: s.userId }, data: { isActive: false } });
    expect((await refresh(s.token, s.deviceId)).status).toBe(401);
  });

  it('stores neither an access token nor a readable refresh token in the rotation cache', async () => {
    const s = await session();
    const result = await refresh(s.token, s.deviceId);
    const row = await prisma.refreshTokenRotationCache.findUniqueOrThrow({ where: { originalTokenHash: sha256Hex(s.token) } });
    expect(row.cachedAccessToken).toBe('');
    expect(row.cachedRefreshToken).not.toContain(result.next ?? '-');
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(10_000);
  });

  it('logout through the service ends every live token of that device only', async () => {
    const a = await session();
    const otherDevice = randomUUID();
    const otherToken = randomOpaqueToken();
    await authRepository.storeRefreshToken(a.userId, otherToken, otherDevice, new Date(Date.now() + 3_600_000));
    const access = authService.generateAccessToken({ id: a.userId, role: 'supervisor', email: null, branchIds: [] });
    await authService.logout(access, a.token);
    const live = await liveTokens(a.userId);
    expect(live.map((row) => row.deviceId)).toEqual([otherDevice]);
  });
});
