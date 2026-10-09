import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@potato-corner/shared';

/**
 * POS-PERF-P29 — real-Postgres integration coverage for the staff-PIN
 * system: concurrent provisioning uniqueness, cross-branch isolation,
 * verification-token binding/expiry/payload-mismatch, idempotent retry, and
 * the evidence-upload consume gate. Same safety convention as
 * inventory-approval.integration.test.ts — only runs against a loopback
 * DATABASE_URL, never Supabase/production.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { prisma } = await import('../../lib/prisma.js');
const { staffPinService } = await import('./staff-pin.service.js');
const { staffPinRepository } = await import('./staff-pin.repository.js');
const { checkIdempotency, recordIdempotencyResult, InventoryIdempotencyConflictError } = await import('../../lib/inventory-idempotency.js');
const { consumeInventoryEvidence } = await import('../universal-inventory/universal-inventory.service.js');
const { sha256Hex } = await import('../../lib/hash.js');

function actor(role: 'super_admin' | 'supervisor' | 'branch', userId: string, branchIds?: string[]): JwtPayload {
  const base = { user_id: userId, email: `${userId}@test.local`, iat: 0, exp: 9999999999 };
  if (role === 'super_admin') return { ...base, role } as JwtPayload;
  return { ...base, role, branch_ids: branchIds ?? [] } as JwtPayload;
}

describe.skipIf(!isLocalDatabase)('staff-pin integration (real Postgres)', () => {
  let branchAId: string;
  let branchBId: string;
  let staff1Id: string;
  let staff2Id: string;
  let adminUserId: string;

  beforeAll(async () => {
    const branchA = await prisma.branch.create({
      data: { name: 'P29 Branch A', code: `P29A-${randomUUID().slice(0, 8)}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchAId = branchA.id;
    const branchB = await prisma.branch.create({
      data: { name: 'P29 Branch B', code: `P29B-${randomUUID().slice(0, 8)}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchBId = branchB.id;

    const staff1 = await prisma.user.create({
      data: { role: 'staff', firstName: 'Staff', lastName: 'One', employmentType: 'regular', email: `staff1-${randomUUID()}@test.local` },
    });
    staff1Id = staff1.id;
    await prisma.userBranchAssignment.create({ data: { userId: staff1Id, branchId: branchAId } });

    const staff2 = await prisma.user.create({
      data: { role: 'staff', firstName: 'Staff', lastName: 'Two', employmentType: 'regular', email: `staff2-${randomUUID()}@test.local` },
    });
    staff2Id = staff2.id;
    await prisma.userBranchAssignment.create({ data: { userId: staff2Id, branchId: branchAId } });

    const admin = await prisma.user.create({
      data: { role: 'super_admin', firstName: 'Admin', lastName: 'User', employmentType: 'regular', email: `admin-${randomUUID()}@test.local` },
    });
    adminUserId = admin.id;
  });

  afterAll(async () => {
    await prisma.staffPinVerification.deleteMany({ where: { branchId: { in: [branchAId, branchBId] } } });
    await prisma.staffPinBranchLookup.deleteMany({ where: { branchId: { in: [branchAId, branchBId] } } });
    await prisma.staffPin.deleteMany({ where: { userId: { in: [staff1Id, staff2Id] } } });
    await prisma.inventoryOperationAttempt.deleteMany({ where: { branchId: { in: [branchAId, branchBId] } } });
    await prisma.inventoryEvidenceUpload.deleteMany({ where: { branchId: { in: [branchAId, branchBId] } } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: { in: [staff1Id, staff2Id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [staff1Id, staff2Id, adminUserId] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchAId, branchBId] } } });
  });

  it('two staff in the same branch cannot concurrently provision the same PIN — exactly one succeeds', async () => {
    const results = await Promise.allSettled([
      staffPinService.setPin(staff1Id, '246810', actor('super_admin', adminUserId), null),
      staffPinService.setPin(staff2Id, '246810', actor('super_admin', adminUserId), null),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0]?.reason as { code?: string })?.code).toBe('PIN_ALREADY_IN_USE');

    // Clean up whichever one succeeded so later tests start from a clean slate.
    await prisma.staffPinVerification.deleteMany({});
    await prisma.staffPinBranchLookup.deleteMany({});
    await prisma.staffPin.deleteMany({ where: { userId: { in: [staff1Id, staff2Id] } } });
  });

  it('a PIN set for a staff member in branch A cannot be verified from branch B (cross-branch isolation)', async () => {
    await staffPinService.setPin(staff1Id, '135790', actor('super_admin', adminUserId), null);

    const verifiedInOwnBranch = await staffPinService.verifyPin(
      { branchId: branchAId, pin: '135790', operation: 'WASTE' },
      actor('branch', randomUUID(), [branchAId]),
    );
    expect(verifiedInOwnBranch.staff_name).toBe('Staff One');

    await expect(
      staffPinService.verifyPin({ branchId: branchBId, pin: '135790', operation: 'WASTE' }, actor('branch', randomUUID(), [branchBId])),
    ).rejects.toMatchObject({ code: 'INVALID_PIN' });
  });

  it('a stale/forged verification token is rejected at consume time', async () => {
    await expect(
      staffPinService.consumeVerification({
        token: 'this-token-was-never-issued',
        actorUserId: randomUUID(),
        branchId: branchAId,
        operation: 'WASTE',
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_NOT_FOUND' });
  });

  it('a verification token is consumed exactly once — a replay attempt is rejected', async () => {
    const draft = { branchId: branchAId, pin: '135790', operation: 'WASTE' as const, quantity: 3, inventoryItemId: undefined };
    const verified = await staffPinService.verifyPin(draft, actor('branch', randomUUID(), [branchAId]));

    const consumed = await staffPinService.consumeVerification({
      token: verified.verification_token,
      actorUserId: randomUUID(),
      branchId: branchAId,
      operation: 'WASTE',
      quantity: 3,
    });
    expect(consumed.responsibleStaffName).toBe('Staff One');

    await expect(
      staffPinService.consumeVerification({
        token: verified.verification_token,
        actorUserId: randomUUID(),
        branchId: branchAId,
        operation: 'WASTE',
        quantity: 3,
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_ALREADY_CONSUMED' });
  });

  it('a payload change after verification invalidates the token', async () => {
    const draft = { branchId: branchAId, pin: '135790', operation: 'WASTE' as const, quantity: 3 };
    const verified = await staffPinService.verifyPin(draft, actor('branch', randomUUID(), [branchAId]));

    await expect(
      staffPinService.consumeVerification({
        token: verified.verification_token,
        actorUserId: randomUUID(),
        branchId: branchAId,
        operation: 'WASTE',
        quantity: 999, // changed after verification
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_PAYLOAD_MISMATCH' });
  });

  it('PIN revoke invalidates every outstanding unconsumed verification token', async () => {
    const draft = { branchId: branchAId, pin: '135790', operation: 'ADJUSTMENT' as const, quantity: 1 };
    const verified = await staffPinService.verifyPin(draft, actor('branch', randomUUID(), [branchAId]));

    await staffPinService.revokePin(staff1Id, actor('super_admin', adminUserId), null);

    await expect(
      staffPinService.consumeVerification({
        token: verified.verification_token,
        actorUserId: randomUUID(),
        branchId: branchAId,
        operation: 'ADJUSTMENT',
        quantity: 1,
      }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_REVOKED' });

    // And the PIN itself is no longer verifiable at all post-revoke.
    await expect(staffPinService.verifyPin(draft, actor('branch', randomUUID(), [branchAId]))).rejects.toMatchObject({ code: 'INVALID_PIN' });
  });

  it('idempotent retry with the same key+payload replays the cached result without re-executing', async () => {
    const key = randomUUID();
    const actorUserId = randomUUID();
    const payloadHash = sha256Hex(JSON.stringify({ quantity: 5 }));

    const first = await checkIdempotency({ idempotencyKey: key, actorUserId, branchId: branchAId, operation: 'WASTE', payloadHash });
    expect(first.cachedResultId).toBeNull();
    await recordIdempotencyResult(key, actorUserId, 'movement-123');

    const retry = await checkIdempotency({ idempotencyKey: key, actorUserId, branchId: branchAId, operation: 'WASTE', payloadHash });
    expect(retry.cachedResultId).toBe('movement-123');
  });

  it('idempotent retry with the same key but a different payload is rejected as a conflict', async () => {
    const key = randomUUID();
    const actorUserId = randomUUID();
    const payloadHashA = sha256Hex(JSON.stringify({ quantity: 5 }));
    const payloadHashB = sha256Hex(JSON.stringify({ quantity: 6 }));

    await checkIdempotency({ idempotencyKey: key, actorUserId, branchId: branchAId, operation: 'WASTE', payloadHash: payloadHashA });

    await expect(
      checkIdempotency({ idempotencyKey: key, actorUserId, branchId: branchAId, operation: 'WASTE', payloadHash: payloadHashB }),
    ).rejects.toBeInstanceOf(InventoryIdempotencyConflictError);
  });

  it('evidence is consumed exactly once — a second submit with the same evidenceKey is rejected', async () => {
    const uploaderId = randomUUID();
    const row = await staffPinRepository.createEvidence({
      branchId: branchAId,
      uploadedByUserId: uploaderId,
      storageKey: `evidence/${branchAId}/test.webp`,
      proofType: 'gallery_upload',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const consumed = await consumeInventoryEvidence(row.id, uploaderId, branchAId);
    expect(consumed.proofKey).toBe(row.storageKey);

    await expect(consumeInventoryEvidence(row.id, uploaderId, branchAId)).rejects.toMatchObject({ code: 'EVIDENCE_ALREADY_CONSUMED' });
  });

  it('evidence uploaded by a different actor or for a different branch cannot be consumed', async () => {
    const uploaderId = randomUUID();
    const row = await staffPinRepository.createEvidence({
      branchId: branchAId,
      uploadedByUserId: uploaderId,
      storageKey: `evidence/${branchAId}/test2.webp`,
      proofType: 'gallery_upload',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(consumeInventoryEvidence(row.id, randomUUID(), branchAId)).rejects.toMatchObject({ code: 'EVIDENCE_NOT_FOUND' });
    await expect(consumeInventoryEvidence(row.id, uploaderId, branchBId)).rejects.toMatchObject({ code: 'EVIDENCE_NOT_FOUND' });
  });

  it('expired evidence cannot be consumed', async () => {
    const uploaderId = randomUUID();
    const row = await staffPinRepository.createEvidence({
      branchId: branchAId,
      uploadedByUserId: uploaderId,
      storageKey: `evidence/${branchAId}/expired.webp`,
      proofType: 'gallery_upload',
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(consumeInventoryEvidence(row.id, uploaderId, branchAId)).rejects.toMatchObject({ code: 'EVIDENCE_EXPIRED' });
  });
});
