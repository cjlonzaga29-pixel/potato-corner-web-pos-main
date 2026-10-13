import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P35R4 — final scope check, inactive-supervisor branch. Tests an
 * existing (still cryptographically valid, unexpired, unrevoked) access
 * token against a P35 catalog mutation route AFTER the supervisor account
 * backing it is deactivated. authenticate.ts only rejects a token that's
 * expired or in the Postgres revocation table — deactivation revokes
 * refresh tokens (authRepository.revokeAllUserTokens), never blacklists the
 * still-live access token itself. authorize.ts's role check reads only the
 * JWT's role claim, never touches the database. requireActiveEmployee
 * explicitly no-ops for every role except staff. So unless some other
 * check in the catalog-mutation path re-reads is_active, a deactivated
 * supervisor's live token keeps working until its own TTL expires. Boots
 * the real Express app + Postgres, exactly like
 * universal-inventory.http-concurrency.integration.test.ts.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

describe.skipIf(!isLocalDatabase)('product mutation authorization after supervisor deactivation (real Express + Postgres)', () => {
  let server: Server;
  let baseUrl: string;
  let supervisorId: string;
  let token: string;
  let productId: string;
  let setupSucceeded = false;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    const sup = await prisma.user.create({
      data: {
        role: 'supervisor',
        firstName: 'Sup',
        lastName: 'Deactivated',
        employmentType: 'regular',
        email: `supdeact-${randomUUID()}@test.local`,
        isActive: true,
      },
    });
    supervisorId = sup.id;
    token = generateSupervisorToken([], { userId: supervisorId });

    const product = await prisma.product.create({
      data: { name: `P35R4 Inactive-Sup Product ${randomUUID().slice(0, 8)}`, createdBy: supervisorId },
    });
    productId = product.id;

    setupSucceeded = true;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!setupSucceeded) return;
    await prisma.product.deleteMany({ where: { createdBy: supervisorId } });
    await prisma.user.deleteMany({ where: { id: supervisorId } });
  });

  it('rejects a product update from a still-valid access token once its supervisor account is deactivated', async () => {
    await prisma.user.update({
      where: { id: supervisorId },
      data: { isActive: false, status: 'inactive', deactivatedAt: new Date(), deactivationReason: 'test' },
    });

    const res = await fetch(`${baseUrl}/api/products/${productId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed by deactivated supervisor' }),
    });

    expect(res.status).not.toBe(200);

    const finalRow = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(finalRow.name).not.toBe('Renamed by deactivated supervisor');
  });
});
