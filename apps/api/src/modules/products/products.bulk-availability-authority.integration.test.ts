import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P36R5 — PATCH /:productId/branch-availability/bulk's body is
 * `{ updates: [{ branch_id, is_available }, ...] }`; the router's
 * branchGuard middleware only ever extracts a single top-level branch_id
 * (lib/request.ts's extractBranchId), found none in this shape, and 400'd
 * BRANCH_ID_REQUIRED before products.service.ts's bulkUpdateBranchProductAvailability
 * ever ran — for every supervisor, the route's only allowed caller
 * (POS-PERF-P35 removed super_admin's catalog write access). Proves the fix:
 * branchGuard removed from the route, authorization moved into the service,
 * checked per branch_id in the array.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

describe.skipIf(!isLocalDatabase)('bulk branch-availability authorization (real Express + Postgres)', () => {
  let server: Server;
  let baseUrl: string;

  let branchAId: string;
  let branchBId: string;
  let branchOutsideId: string;
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

    const suffix = randomUUID().slice(0, 8);
    const [a, b, outside] = await Promise.all([
      prisma.branch.create({ data: { name: `P36R5 Bulk A ${suffix}`, code: `P36R5BA-${suffix}`, address: 'Test', city: 'Test', status: 'active' } }),
      prisma.branch.create({ data: { name: `P36R5 Bulk B ${suffix}`, code: `P36R5BB-${suffix}`, address: 'Test', city: 'Test', status: 'active' } }),
      prisma.branch.create({ data: { name: `P36R5 Bulk Outside ${suffix}`, code: `P36R5BO-${suffix}`, address: 'Test', city: 'Test', status: 'active' } }),
    ]);
    branchAId = a.id;
    branchBId = b.id;
    branchOutsideId = outside.id;

    const sup = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Bulk', lastName: 'Sup', employmentType: 'regular', email: `p36r5-bulk-${suffix}@test.local` },
    });
    supervisorId = sup.id;
    token = generateSupervisorToken([], { userId: supervisorId });
    await Promise.all([
      prisma.userBranchAssignment.create({ data: { userId: supervisorId, branchId: branchAId } }),
      prisma.userBranchAssignment.create({ data: { userId: supervisorId, branchId: branchBId } }),
    ]);

    const product = await prisma.product.create({ data: { name: `P36R5 Bulk Product ${suffix}`, status: 'active', createdBy: supervisorId } });
    productId = product.id;
    await prisma.branchProductAvailability.createMany({
      data: [
        { branchId: branchAId, productId, isAvailable: true },
        { branchId: branchBId, productId, isAvailable: true },
        { branchId: branchOutsideId, productId, isAvailable: true },
      ],
    });

    setupSucceeded = true;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!setupSucceeded) return;
    await prisma.branchProductAvailability.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: supervisorId } });
    await prisma.user.deleteMany({ where: { id: supervisorId } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchAId, branchBId, branchOutsideId] } } });
  });

  it('succeeds for a batch of branches the supervisor actually controls', async () => {
    const res = await fetch(`${baseUrl}/api/products/${productId}/branch-availability/bulk`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: [
          { branch_id: branchAId, is_available: false },
          { branch_id: branchBId, is_available: true },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const [availA, availB] = await Promise.all([
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchAId, productId } } }),
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchBId, productId } } }),
    ]);
    expect(availA.isAvailable).toBe(false);
    expect(availB.isAvailable).toBe(true);

    await prisma.branchProductAvailability.update({ where: { branchId_productId: { branchId: branchAId, productId } }, data: { isAvailable: true } });
  });

  it('rejects the whole batch when any one branch_id is outside the supervisor\'s active assignments, touching nothing', async () => {
    const res = await fetch(`${baseUrl}/api/products/${productId}/branch-availability/bulk`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: [
          { branch_id: branchAId, is_available: false },
          { branch_id: branchOutsideId, is_available: false },
        ],
      }),
    });
    expect(res.status).toBe(403);

    const [availA, availOutside] = await Promise.all([
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchAId, productId } } }),
      prisma.branchProductAvailability.findUniqueOrThrow({ where: { branchId_productId: { branchId: branchOutsideId, productId } } }),
    ]);
    expect(availA.isAvailable).toBe(true);
    expect(availOutside.isAvailable).toBe(true);
  });
});
