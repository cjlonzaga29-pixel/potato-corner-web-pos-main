import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * POS-PERF-P35R3 — real-Postgres race coverage for catalog-assignment.
 * catalog-assignment.service.test.ts exercises every branch with a fully
 * mocked repository, which proves the service calls casUpdateManagedBy with
 * the right arguments but can never prove the CAS itself resolves a genuine
 * concurrent write race on a real database — two mocked calls can't contend
 * for the same row. This suite runs createAssignment for real, concurrently,
 * against the same local disposable Postgres inventory-approval's real-DB
 * suite uses, following the identical isLocalDatabase safety gate.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { catalogAssignmentService } = await import('./catalog-assignment.service.js');

const SUPER_ADMIN = { id: '', role: 'super_admin' };

describe.skipIf(!isLocalDatabase)('catalog-assignment integration (real Postgres)', () => {
  let adminId: string;
  let branchA: string;
  let branchB: string;
  let supervisorInBranchA: string;
  let supervisorInBranchB: string;
  let supervisorInBothBranches: string;
  let setupSucceeded = false;

  beforeAll(async () => {
    const admin = await prisma.user.create({
      data: { role: 'super_admin', firstName: 'Admin', lastName: 'User', employmentType: 'regular', email: `admin-${randomUUID()}@test.local` },
    });
    adminId = admin.id;
    SUPER_ADMIN.id = adminId;

    const a = await prisma.branch.create({
      data: { name: 'P35R3 Branch A', code: `P35R3A-${randomUUID().slice(0, 8)}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchA = a.id;
    const b = await prisma.branch.create({
      data: { name: 'P35R3 Branch B', code: `P35R3B-${randomUUID().slice(0, 8)}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchB = b.id;

    const supA = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Sup', lastName: 'A', employmentType: 'regular', email: `supa-${randomUUID()}@test.local` },
    });
    supervisorInBranchA = supA.id;
    await prisma.userBranchAssignment.create({ data: { userId: supervisorInBranchA, branchId: branchA } });

    const supB = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Sup', lastName: 'B', employmentType: 'regular', email: `supb-${randomUUID()}@test.local` },
    });
    supervisorInBranchB = supB.id;
    await prisma.userBranchAssignment.create({ data: { userId: supervisorInBranchB, branchId: branchB } });

    const supAB = await prisma.user.create({
      data: { role: 'supervisor', firstName: 'Sup', lastName: 'AB', employmentType: 'regular', email: `supab-${randomUUID()}@test.local` },
    });
    supervisorInBothBranches = supAB.id;
    await prisma.userBranchAssignment.create({ data: { userId: supervisorInBothBranches, branchId: branchA } });
    await prisma.userBranchAssignment.create({ data: { userId: supervisorInBothBranches, branchId: branchB } });

    setupSucceeded = true;
  });

  afterAll(async () => {
    if (!setupSucceeded) return;
    await prisma.catalogManagementAssignment.deleteMany({ where: { assignedBy: adminId } });
    await prisma.product.deleteMany({ where: { createdBy: adminId } });
    await prisma.inventoryCategory.deleteMany({ where: { createdBy: adminId } });
    await prisma.userBranchAssignment.deleteMany({
      where: { userId: { in: [supervisorInBranchA, supervisorInBranchB, supervisorInBothBranches] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, supervisorInBranchA, supervisorInBranchB, supervisorInBothBranches] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchA, branchB] } } });
  });

  it('two concurrent createAssignment calls on the same unmanaged resource: the CAS lets exactly one win, the other gets a real 409 ASSIGNMENT_CONFLICT — not a mocked one', async () => {
    const category = await prisma.inventoryCategory.create({
      data: { name: `P35R3 Category ${randomUUID().slice(0, 8)}`, createdBy: adminId },
    });

    const results = await Promise.allSettled([
      catalogAssignmentService.createAssignment(
        { resource_type: 'INVENTORY_CATEGORY', resource_id: category.id, supervisor_id: supervisorInBranchA, reason: 'Concurrent assignment race test — attempt A' },
        SUPER_ADMIN,
        null,
      ),
      catalogAssignmentService.createAssignment(
        { resource_type: 'INVENTORY_CATEGORY', resource_id: category.id, supervisor_id: supervisorInBranchB, reason: 'Concurrent assignment race test — attempt B' },
        SUPER_ADMIN,
        null,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'ASSIGNMENT_CONFLICT' });

    // The row ends up managed by whichever attempt's CAS actually won — not
    // both, not neither, and not silently overwritten by the loser.
    const finalRow = await prisma.inventoryCategory.findUniqueOrThrow({ where: { id: category.id } });
    expect([supervisorInBranchA, supervisorInBranchB]).toContain(finalRow.managedBy);

    // Exactly one assignment-history row was written for this resource —
    // the loser's CAS failure happened before createAssignmentRecord, so it
    // never left a phantom audit row behind.
    const history = await prisma.catalogManagementAssignment.findMany({ where: { resourceType: 'INVENTORY_CATEGORY', resourceId: category.id } });
    expect(history.length).toBe(1);
    expect(history[0]?.newManagedBy).toBe(finalRow.managedBy);
  });

  it('three-way concurrent reassignment of an already-managed resource: exactly one of the challengers wins the CAS pinned to the current manager', async () => {
    const category = await prisma.inventoryCategory.create({
      data: { name: `P35R3 Category ${randomUUID().slice(0, 8)}`, createdBy: adminId, managedBy: supervisorInBranchA },
    });

    const results = await Promise.allSettled([
      catalogAssignmentService.createAssignment(
        { resource_type: 'INVENTORY_CATEGORY', resource_id: category.id, supervisor_id: supervisorInBranchB, reason: 'Concurrent reassignment race — attempt 1' },
        SUPER_ADMIN,
        null,
      ),
      catalogAssignmentService.createAssignment(
        { resource_type: 'INVENTORY_CATEGORY', resource_id: category.id, supervisor_id: supervisorInBothBranches, reason: 'Concurrent reassignment race — attempt 2' },
        SUPER_ADMIN,
        null,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const finalRow = await prisma.inventoryCategory.findUniqueOrThrow({ where: { id: category.id } });
    expect(finalRow.managedBy).not.toBe(supervisorInBranchA);
    expect([supervisorInBranchB, supervisorInBothBranches]).toContain(finalRow.managedBy);
  });

  it('a branch-exclusive product cannot be assigned to a supervisor whose branch assignment to that exact branch was revoked moments earlier — the branch-scope check re-reads live assignments, not a cached/stale view', async () => {
    const product = await prisma.product.create({
      data: { name: `P35R3 Product ${randomUUID().slice(0, 8)}`, createdBy: adminId, branchExclusive: true, exclusiveBranchId: branchA },
    });

    // supervisorInBranchA starts eligible (assigned to branchA). Revoke that
    // assignment, simulating an admin pulling branch access a moment before
    // the assignment call actually lands, then attempt the assignment.
    await prisma.userBranchAssignment.updateMany({
      where: { userId: supervisorInBranchA, branchId: branchA },
      data: { removedAt: new Date() },
    });

    await expect(
      catalogAssignmentService.createAssignment(
        { resource_type: 'PRODUCT', resource_id: product.id, supervisor_id: supervisorInBranchA, reason: 'Revoked-branch race test' },
        SUPER_ADMIN,
        null,
      ),
    ).rejects.toMatchObject({ code: 'SUPERVISOR_BRANCH_SCOPE_INVALID' });

    const finalRow = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(finalRow.managedBy).toBeNull();

    // Restore for cleanliness/isolation from any other assertion in this file.
    await prisma.userBranchAssignment.updateMany({
      where: { userId: supervisorInBranchA, branchId: branchA },
      data: { removedAt: null },
    });
  });

  it('the write path never trusts a stale preview snapshot: when the resource is reassigned after the preview was read but before confirm, createAssignment\'s own fresh read drives the CAS, so it succeeds against the NEW previous manager rather than silently conflicting against — or overwriting — the preview-time value', async () => {
    const product = await prisma.product.create({
      data: { name: `P35R3 Product ${randomUUID().slice(0, 8)}`, createdBy: adminId, branchExclusive: true, exclusiveBranchId: branchB },
    });

    // Preview is read first, exactly as the real UI flow does (managedBy is
    // NULL at this point), then the underlying resource is reassigned by
    // someone else before the confirm actually posts.
    const preview = await catalogAssignmentService.previewAssignment('PRODUCT', product.id);
    expect(preview.current_managed_by).toBeNull();
    await prisma.product.update({ where: { id: product.id }, data: { managedBy: supervisorInBothBranches } });

    // If the write path incorrectly carried the preview's stale NULL
    // forward as its CAS expectation, this call's CAS (WHERE managed_by =
    // NULL) would no longer match the now-non-NULL row and would wrongly
    // 409. It must instead re-read ownership itself and succeed, pinned to
    // the fresh value.
    const result = await catalogAssignmentService.createAssignment(
      { resource_type: 'PRODUCT', resource_id: product.id, supervisor_id: supervisorInBranchB, reason: 'Stale-preview race test' },
      SUPER_ADMIN,
      null,
    );
    expect(result.previous_managed_by).toBe(supervisorInBothBranches);
    expect(result.new_managed_by).toBe(supervisorInBranchB);

    const finalRow = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(finalRow.managedBy).toBe(supervisorInBranchB);
  });
});
