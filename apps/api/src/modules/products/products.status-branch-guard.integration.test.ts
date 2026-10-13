import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P36R2 — real-browser verification (Archive confirmation) found
 * that PATCH /api/products/:id/status 400s BRANCH_ID_REQUIRED for every
 * supervisor global lifecycle change (archive/discontinue/restore), even
 * though products.router.ts's own comment says branch_id is intentionally
 * optional for that path and products.service.ts's changeProductStatus
 * already authorizes it correctly via hasActiveCatalogAuthorityForProduct.
 * The bug was `branchGuard` applied unconditionally on that route, 400ing
 * before the body-aware service logic ever ran. Fixed with
 * `branchGuardOptional` (branch-guard.ts), which only enforces
 * hasBranchAccess when branch_id is actually present. Boots the real
 * Express app + Postgres, same pattern as
 * products.inactive-supervisor.integration.test.ts.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

describe.skipIf(!isLocalDatabase)('PATCH /products/:id/status — global transition with no branch_id (real Express + Postgres)', () => {
  let server: Server;
  let baseUrl: string;
  let supervisorId: string;
  let branchId: string;
  let token: string;
  let productId: string;
  let setupSucceeded = false;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    const suffix = randomUUID().slice(0, 8);
    const sup = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Sup', lastName: 'Archive', employmentType: 'regular', email: `p36r2-archive-${suffix}@test.local` },
    });
    supervisorId = sup.id;
    token = generateSupervisorToken([], { userId: supervisorId });

    const branch = await prisma.branch.create({
      data: { name: `P36R2 Archive Branch ${suffix}`, code: `P36R2A-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchId = branch.id;
    await prisma.userBranchAssignment.create({ data: { userId: supervisorId, branchId } });

    const product = await prisma.product.create({
      data: { name: `P36R2 Archive Product ${suffix}`, status: 'active', createdBy: supervisorId, branchExclusive: true, exclusiveBranchId: branchId },
    });
    productId = product.id;

    setupSucceeded = true;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!setupSucceeded) return;
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: supervisorId } });
    await prisma.user.deleteMany({ where: { id: supervisorId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
  });

  it('archives (no branch_id in the body) without a spurious BRANCH_ID_REQUIRED 400', async () => {
    const res = await fetch(`${baseUrl}/api/products/${productId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('archived');

    const row = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(row.status).toBe('archived');
  });

  it('still rejects a branch-scoped status change naming a branch_id the supervisor has no access to', async () => {
    const otherBranch = await prisma.branch.create({
      data: { name: 'P36R2 Archive Other Branch', code: `P36R2AO-${randomUUID().slice(0, 8)}`, address: 'Test', city: 'Test', status: 'active' },
    });

    const res = await fetch(`${baseUrl}/api/products/${productId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', branch_id: otherBranch.id }),
    });

    expect(res.status).toBe(403);
    await prisma.branch.deleteMany({ where: { id: otherBranch.id } });
  });
});
