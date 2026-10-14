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

  /**
   * POS-PERF-P36R3 — §2: branchGuardOptional must never let "no branch_id"
   * stand in for global authority on its own; changeProductStatus's own
   * hasActiveCatalogAuthorityForProduct check is what actually has to reject
   * a supervisor with zero active-branch overlap with a shared (non-
   * exclusive) product's selling branches. branchGuardOptional skipping
   * straight to next() for the no-branch_id case only defers the decision —
   * it must never be read as "therefore authorized."
   */
  it('rejects a global status change (no branch_id) for a shared product the supervisor has zero active-branch overlap with', async () => {
    const suffix = randomUUID().slice(0, 8);
    const outsiderSup = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Outsider', lastName: 'Sup', employmentType: 'regular', email: `p36r3-outsider-${suffix}@test.local` },
    });
    const outsiderToken = generateSupervisorToken([], { userId: outsiderSup.id });

    const sharedProductBranch = await prisma.branch.create({
      data: { name: `P36R3 Shared Branch ${suffix}`, code: `P36R3SB-${suffix}`, address: 'Test', city: 'Test', status: 'active' },
    });
    const sharedProduct = await prisma.product.create({
      data: { name: `P36R3 Shared Product ${suffix}`, status: 'active', createdBy: supervisorId },
    });
    await prisma.branchProductAvailability.create({
      data: { branchId: sharedProductBranch.id, productId: sharedProduct.id, isAvailable: true },
    });

    // outsiderSup has zero UserBranchAssignment rows anywhere — not even to
    // sharedProductBranch — so hasActiveCatalogAuthorityForProduct's
    // intersection check against sellingBranchIds has nothing to intersect.
    const res = await fetch(`${baseUrl}/api/products/${sharedProduct.id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${outsiderToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    });

    expect(res.status).toBe(403);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: sharedProduct.id } });
    expect(row.status).toBe('active');

    await prisma.branchProductAvailability.deleteMany({ where: { productId: sharedProduct.id } });
    await prisma.product.deleteMany({ where: { id: sharedProduct.id } });
    await prisma.branch.deleteMany({ where: { id: sharedProductBranch.id } });
    await prisma.user.deleteMany({ where: { id: outsiderSup.id } });
  });

  it('rejects a branch-scoped status change naming a syntactically-valid but nonexistent branch_id', async () => {
    const forgedBranchId = randomUUID();

    const res = await fetch(`${baseUrl}/api/products/${productId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', branch_id: forgedBranchId }),
    });

    // Never a real branch, so it can't appear in the supervisor's
    // findAllActiveBranchIds result — hasBranchAccess correctly denies it
    // the same as any other branch the supervisor lacks access to.
    expect(res.status).toBe(403);
  });

  it('rejects a branch_id submitted as a non-string (array/object) — Zod validation must reject it before branchGuardOptional ever treats it as absent', async () => {
    const res = await fetch(`${baseUrl}/api/products/${productId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', branch_id: { nested: branchId } }),
    });

    expect(res.status).toBe(422);
  });

  it('rejects a branch-scoped status change once the supervisor\'s assignment to that branch has been revoked', async () => {
    const suffix = randomUUID().slice(0, 8);
    const revokedSup = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Revoked', lastName: 'Sup', employmentType: 'regular', email: `p36r3-revoked-${suffix}@test.local` },
    });
    const revokedToken = generateSupervisorToken([], { userId: revokedSup.id });
    await prisma.userBranchAssignment.create({ data: { userId: revokedSup.id, branchId, removedAt: new Date() } });

    const res = await fetch(`${baseUrl}/api/products/${productId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${revokedToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', branch_id: branchId }),
    });

    expect(res.status).toBe(403);

    await prisma.userBranchAssignment.deleteMany({ where: { userId: revokedSup.id } });
    await prisma.user.deleteMany({ where: { id: revokedSup.id } });
  });

  it('rejects any status change, global or branch-scoped, once the supervisor account itself is deactivated (requireActiveSupervisor)', async () => {
    const suffix = randomUUID().slice(0, 8);
    const deactivatedSup = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Deact', lastName: 'Sup', employmentType: 'regular', email: `p36r3-deact-${suffix}@test.local`, isActive: true },
    });
    const deactivatedToken = generateSupervisorToken([], { userId: deactivatedSup.id });
    await prisma.userBranchAssignment.create({ data: { userId: deactivatedSup.id, branchId } });
    await prisma.user.update({
      where: { id: deactivatedSup.id },
      data: { isActive: false, status: 'inactive', deactivatedAt: new Date(), deactivationReason: 'test' },
    });

    const res = await fetch(`${baseUrl}/api/products/${productId}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${deactivatedToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', branch_id: branchId }),
    });

    expect(res.status).not.toBe(200);

    await prisma.userBranchAssignment.deleteMany({ where: { userId: deactivatedSup.id } });
    await prisma.user.deleteMany({ where: { id: deactivatedSup.id } });
  });
});
