import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P29R2 — real Express + real Postgres HTTP-level concurrency
 * coverage for the manual-inventory write endpoints: concurrent identical
 * submissions under the same Idempotency-Key, conflicting payload reuse of
 * that same key, and committed replay after the PIN verification/evidence
 * that produced the original result would have expired. Boots the real
 * `app` on an ephemeral loopback port and drives it with the platform
 * `fetch` — no supertest dependency exists in this repo (see every
 * `*.router.test.ts` file's own comment on that) and none is added here.
 * Same "never runs against anything but a loopback DATABASE_URL" convention
 * as inventory-approval.integration.test.ts / staff-pin.integration.test.ts.
 *
 * Storage caveat: this environment's SUPABASE_URL is a dummy/unreachable
 * placeholder (apps/api/.env), so there is no real Supabase Storage to run
 * evidence uploads or signed-URL generation against here. Evidence rows are
 * inserted directly (same technique staff-pin.integration.test.ts's own
 * evidence tests use) rather than performing a real upload, and the one
 * remaining real-network call on the response path — toResponse()'s signed
 * proof-URL lookup — is stubbed to resolve rather than attempt a DNS lookup
 * that cannot succeed here. Every write itself (the actual thing under
 * test: idempotency ledger inserts, InventoryApprovalRequest creation,
 * PIN-verification consumption) still runs for real against Postgres inside
 * the real Express request/response cycle.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { config } = await import('../../config/index.js');
const { staffPinService } = await import('../staff-pin/staff-pin.service.js');
const { staffPinRepository } = await import('../staff-pin/staff-pin.repository.js');
const universalInventoryServiceModule = await import('./universal-inventory.service.js');
const { generateBranchToken, generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');
const { ROLES } = await import('@potato-corner/shared');
import type { JwtPayload } from '@potato-corner/shared';

function branchActor(userId: string, branchId: string): JwtPayload {
  const now = Math.floor(Date.now() / 1000);
  return { user_id: userId, role: ROLES.BRANCH, email: `${userId}@test.local`, branch_ids: [branchId], iat: now, exp: now + 900 };
}

describe.skipIf(!isLocalDatabase)('universal-inventory write endpoints — HTTP concurrency (real Express + Postgres)', () => {
  let server: Server;
  let baseUrl: string;
  let branchId: string;
  let unitId: string;
  let itemId: string;
  let branchUserId: string;
  let branchToken: string;
  let originalFlag: boolean;

  beforeAll(async () => {
    originalFlag = config.manualInventoryApprovalRequired;
    (config as { manualInventoryApprovalRequired: boolean }).manualInventoryApprovalRequired = true;
    vi.spyOn(universalInventoryServiceModule, 'getSignedInventoryProofUrl').mockResolvedValue('https://example.invalid/stubbed-signed-url');

    const branch = await prisma.branch.create({
      data: { name: 'P29R2 HTTP Test Branch', code: `P29R2-${randomUUID().slice(0, 8)}`, address: 'Test', city: 'Test', status: 'active' },
    });
    branchId = branch.id;

    const unit = await prisma.unitOfMeasure.create({
      data: { code: `pc-${randomUUID().slice(0, 6)}`, name: 'Piece', dimension: 'COUNT', isBaseUnit: true },
    });
    unitId = unit.id;

    const item = await prisma.inventoryItem.create({ data: { name: 'P29R2 HTTP Test Item', baseUnitId: unitId } });
    itemId = item.id;
    await prisma.inventoryStock.create({ data: { branchId, inventoryItemId: itemId, quantityOnHand: 100, quantityReserved: 0, version: 0 } });

    const branchUser = await prisma.user.create({
      data: { role: 'branch', firstName: 'Branch', lastName: 'Acct', employmentType: 'regular', email: `branch-${randomUUID()}@test.local` },
    });
    branchUserId = branchUser.id;
    await prisma.userBranchAssignment.create({ data: { userId: branchUserId, branchId } });
    branchToken = generateBranchToken(branchId, { userId: branchUserId });

    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.inventoryOperationAttempt.deleteMany({ where: { branchId } });
    await prisma.inventoryApprovalRequest.deleteMany({ where: { branchId } });
    await prisma.inventoryItem.deleteMany({ where: { id: itemId } });
    await prisma.unitOfMeasure.deleteMany({ where: { id: unitId } });
    await prisma.userBranchAssignment.deleteMany({ where: { userId: branchUserId } });
    await prisma.user.deleteMany({ where: { id: branchUserId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    (config as { manualInventoryApprovalRequired: boolean }).manualInventoryApprovalRequired = originalFlag;
  });

  /** Fresh staff PIN + verification token + evidence key for one ADJUSTMENT draft, exactly as a real client would obtain them before submitting. */
  async function provisionAdjustmentCredentials(quantityDelta: number, reasonCode = 'count_correction', uploaderUserId: string = branchUserId) {
    const staffUser = await prisma.user.create({
      data: { role: 'staff', firstName: 'Staff', lastName: randomUUID().slice(0, 8), employmentType: 'regular', email: `staff-${randomUUID()}@test.local` },
    });
    await prisma.userBranchAssignment.create({ data: { userId: staffUser.id, branchId } });
    const pin = String(Math.floor(1000 + Math.random() * 8999));
    await staffPinService.setPin(staffUser.id, pin, branchActor(uploaderUserId, branchId), null);

    const verified = await staffPinService.verifyPin(
      { branchId, pin, operation: 'ADJUSTMENT', inventoryItemId: itemId, quantity: quantityDelta, reasonCode },
      branchActor(uploaderUserId, branchId),
    );
    // No real Supabase Storage endpoint exists in this test environment —
    // bypass uploadInventoryEvidence's actual upload the same way
    // staff-pin.integration.test.ts's evidence tests do, inserting the
    // InventoryEvidenceUpload row directly rather than performing a real
    // storage round trip. The HTTP endpoint under test (adjust) only ever
    // consumes the evidence_key through consumeInventoryEvidence, which
    // doesn't care how the row was created — EXCEPT that consumeInventoryEvidence
    // requires evidence.uploadedByUserId to match the actor consuming it
    // (universal-inventory.service.ts's consumeInventoryEvidence), so this
    // must be the same user whose token authenticates the eventual request —
    // branchUserId for the branch-role tests above, the caller-supplied
    // supervisor id for the direct-write tests below.
    const evidence = await staffPinRepository.createEvidence({
      branchId,
      uploadedByUserId: uploaderUserId,
      storageKey: `evidence/${branchId}/${randomUUID()}.png`,
      proofType: 'gallery_upload',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    return { staffUserId: staffUser.id, verificationToken: verified.verification_token, evidenceKey: evidence.id };
  }

  async function postAdjust(body: Record<string, unknown>, idempotencyKey: string) {
    const res = await fetch(`${baseUrl}/api/branches/${branchId}/inventory-stock/${itemId}/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${branchToken}`, 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { data: { id?: string; replayed?: boolean } | null; error: { code: string } | null };
    return { status: res.status, json };
  }

  it('concurrent identical submissions under the same Idempotency-Key create exactly one PENDING request; every losing call resolves consistently (no raw error, no proof consumed twice)', async () => {
    const quantityDelta = 11;
    const { verificationToken, evidenceKey } = await provisionAdjustmentCredentials(quantityDelta);
    const idempotencyKey = randomUUID();
    const body = { quantity_delta: quantityDelta, reason_code: 'count_correction', verification_token: verificationToken, evidence_key: evidenceKey };

    const results = await Promise.all(Array.from({ length: 5 }, () => postAdjust(body, idempotencyKey)));

    // Every response is one of three well-formed, documented outcomes — never an unhandled 500.
    for (const { status, json } of results) {
      expect([200, 201, 409, 422]).toContain(status);
      if (status >= 400) {
        expect(json.error?.code).toBeTruthy();
      }
    }

    const successes = results.filter((r) => r.status === 200 || r.status === 201);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    const resultId = successes[0]?.json.data?.id;
    expect(resultId).toBeTruthy();
    // Every successful response (the original 201 plus any idempotent 200 replays) points at the exact same request id.
    for (const success of successes) {
      expect(success.json.data?.id).toBe(resultId);
    }

    const requests = await prisma.inventoryApprovalRequest.findMany({ where: { branchId, inventoryItemId: itemId, quantityDelta: quantityDelta.toString() } });
    expect(requests.length).toBe(1);
    expect(requests[0]?.id).toBe(resultId);
  });

  it('reusing the same Idempotency-Key with a different payload is rejected as a conflict, not silently applied', async () => {
    const { verificationToken, evidenceKey } = await provisionAdjustmentCredentials(3);
    const idempotencyKey = randomUUID();
    const first = await postAdjust({ quantity_delta: 3, reason_code: 'count_correction', verification_token: verificationToken, evidence_key: evidenceKey }, idempotencyKey);
    expect([200, 201]).toContain(first.status);

    const { verificationToken: secondToken, evidenceKey: secondEvidence } = await provisionAdjustmentCredentials(4);
    const conflicting = await postAdjust(
      { quantity_delta: 4, reason_code: 'count_correction', verification_token: secondToken, evidence_key: secondEvidence },
      idempotencyKey,
    );
    expect(conflicting.status).toBe(409);
    expect(conflicting.json.error?.code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    // The second verification token/evidence were never consumed by the rejected conflicting call — both remain usable under a fresh key.
    const retryKey = randomUUID();
    const retried = await postAdjust(
      { quantity_delta: 4, reason_code: 'count_correction', verification_token: secondToken, evidence_key: secondEvidence },
      retryKey,
    );
    expect([200, 201]).toContain(retried.status);
  });

  it('a committed replay under the same key+payload succeeds from the idempotency cache alone, even though the original verification token is already consumed and cannot be verified again', async () => {
    const { verificationToken, evidenceKey } = await provisionAdjustmentCredentials(6);
    const idempotencyKey = randomUUID();
    const body = { quantity_delta: 6, reason_code: 'count_correction', verification_token: verificationToken, evidence_key: evidenceKey };

    const original = await postAdjust(body, idempotencyKey);
    expect(original.status).toBe(201);
    const originalId = original.json.data?.id;

    // The verification token this request consumed cannot be used again directly...
    await expect(
      staffPinService.consumeVerification({ token: verificationToken, actorUserId: branchUserId, branchId, operation: 'ADJUSTMENT', inventoryItemId: itemId, quantity: 6, reasonCode: 'count_correction' }),
    ).rejects.toMatchObject({ code: 'VERIFICATION_ALREADY_CONSUMED' });

    // ...yet replaying the exact same HTTP request (same key, same body) still succeeds, because checkIdempotency
    // short-circuits to the cached result before ever touching PIN verification/evidence again.
    const replay = await postAdjust(body, idempotencyKey);
    expect(replay.status).toBe(200);
    expect(replay.json.data?.replayed).toBe(true);
    expect(replay.json.data?.id).toBe(originalId);
  });

  /**
   * POS-PERF-P29R3 — the three tests above all exercise the branch-role
   * PENDING-review path, where "applied exactly once" only ever means "one
   * InventoryApprovalRequest row exists" — no stock write happens until a
   * separate approve() call, so a race in THIS endpoint could never double-
   * apply real stock. A supervisor/super_admin actor is different:
   * requiresPendingReview() (universal-inventory.router.ts) is false for
   * them, so this same /adjust endpoint calls universalInventoryService.
   * adjustStock() directly and writes the real ledger inline — a race here
   * is the one that could actually double-apply stock. Asserts the real
   * InventoryStock.quantityOnHand delta and InventoryStockMovement row
   * count directly, not just the idempotency/attempt-row bookkeeping.
   */
  describe('direct-write (supervisor) concurrency — the actual stock mutation, not just the approval-request row', () => {
    let supervisorUserId: string;
    let supervisorToken: string;

    beforeAll(async () => {
      const supervisorUser = await prisma.user.create({
        data: { role: 'supervisor', firstName: 'Supervisor', lastName: 'Direct', employmentType: 'regular', email: `supervisor-${randomUUID()}@test.local` },
      });
      supervisorUserId = supervisorUser.id;
      await prisma.userBranchAssignment.create({ data: { userId: supervisorUserId, branchId } });
      supervisorToken = generateSupervisorToken([branchId], { userId: supervisorUserId });
    });

    afterAll(async () => {
      await prisma.userBranchAssignment.deleteMany({ where: { userId: supervisorUserId } });
      await prisma.user.deleteMany({ where: { id: supervisorUserId } });
    });

    async function postSupervisorAdjust(body: Record<string, unknown>, idempotencyKey: string) {
      const res = await fetch(`${baseUrl}/api/branches/${branchId}/inventory-stock/${itemId}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${supervisorToken}`, 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { data: { id?: string; replayed?: boolean } | null; error: { code: string } | null };
      return { status: res.status, json };
    }

    it('concurrent identical direct-write adjustments under the same Idempotency-Key change InventoryStock exactly once and create exactly one movement', async () => {
      const quantityDelta = 9;
      const { verificationToken, evidenceKey } = await provisionAdjustmentCredentials(quantityDelta, 'count_correction', supervisorUserId);
      const idempotencyKey = randomUUID();
      const body = { quantity_delta: quantityDelta, reason_code: 'count_correction', verification_token: verificationToken, evidence_key: evidenceKey };

      const stockBefore = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
      const movementCountBefore = await prisma.inventoryStockMovement.count({ where: { branchId, inventoryItemId: itemId } });

      const results = await Promise.all(Array.from({ length: 6 }, () => postSupervisorAdjust(body, idempotencyKey)));

      for (const { status, json } of results) {
        expect([200, 201, 409, 422]).toContain(status);
        if (status >= 400) expect(json.error?.code).toBeTruthy();
      }
      const successes = results.filter((r) => r.status === 200 || r.status === 201);
      expect(successes.length).toBeGreaterThanOrEqual(1);
      const resultId = successes[0]?.json.data?.id;
      for (const success of successes) expect(success.json.data?.id).toBe(resultId);

      // The actual mutation — asserted directly, not inferred from the HTTP responses or the idempotency ledger alone.
      const stockAfter = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
      expect(stockAfter.quantityOnHand.toNumber()).toBe(stockBefore.quantityOnHand.toNumber() + quantityDelta);
      const movementCountAfter = await prisma.inventoryStockMovement.count({ where: { branchId, inventoryItemId: itemId } });
      expect(movementCountAfter).toBe(movementCountBefore + 1);

      // Evidence/verification are each single-use — exactly one of the concurrent callers actually consumed them.
      const evidenceRow = await staffPinRepository.findEvidenceById(evidenceKey);
      expect(evidenceRow?.consumedAt).not.toBeNull();
    });

    it('a cached replay after the original verification token/evidence are already consumed still succeeds (idempotency cache, not re-verification)', async () => {
      const quantityDelta = 5;
      const { verificationToken, evidenceKey } = await provisionAdjustmentCredentials(quantityDelta, 'count_correction', supervisorUserId);
      const idempotencyKey = randomUUID();
      const body = { quantity_delta: quantityDelta, reason_code: 'count_correction', verification_token: verificationToken, evidence_key: evidenceKey };

      const original = await postSupervisorAdjust(body, idempotencyKey);
      expect(original.status).toBe(201);
      const stockAfterOriginal = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });

      const replay = await postSupervisorAdjust(body, idempotencyKey);
      expect(replay.status).toBe(200);
      expect(replay.json.data?.replayed).toBe(true);

      // The cached replay must not re-apply the stock mutation a second time.
      const stockAfterReplay = await prisma.inventoryStock.findUniqueOrThrow({ where: { branchId_inventoryItemId: { branchId, inventoryItemId: itemId } } });
      expect(stockAfterReplay.quantityOnHand.toNumber()).toBe(stockAfterOriginal.quantityOnHand.toNumber());
    });
  });
});
