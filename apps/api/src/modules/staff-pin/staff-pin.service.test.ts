import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { ROLES } from '@potato-corner/shared';

vi.mock('./staff-pin.repository.js', () => ({
  staffPinRepository: {
    findByUserId: vi.fn(),
    findById: vi.fn(),
    upsertPin: vi.fn(),
    revoke: vi.fn(),
    deleteBranchLookups: vi.fn(),
    createBranchLookups: vi.fn(),
    findActiveBranchLookup: vi.fn(),
    findActiveAssignedBranchIds: vi.fn(),
    createVerification: vi.fn(),
    findVerificationByTokenDigest: vi.fn(),
    markConsumedIfUnconsumed: vi.fn(),
    revokeOutstandingVerifications: vi.fn(),
    findUserBasic: vi.fn(),
    createEvidence: vi.fn(),
    findEvidenceById: vi.fn(),
    markEvidenceConsumedIfUnconsumed: vi.fn(),
    findExpiredUnconsumedEvidence: vi.fn(),
    deleteEvidenceRows: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({})),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/branch-access.js', () => ({
  hasBranchAccess: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../config/index.js', () => ({
  config: { staffPinHmacSecret: 'test-secret-at-least-32-characters-long' },
}));

const { staffPinRepository } = await import('./staff-pin.repository.js');
const { hasBranchAccess } = await import('../../lib/branch-access.js');
const { staffPinService } = await import('./staff-pin.service.js');

function actor(role: string, userId = 'actor-1') {
  return { user_id: userId, role, email: 'a@test.local', iat: 0, exp: 9999999999, branch_ids: ['branch-1'] } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  (hasBranchAccess as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

describe('staffPinService.setPin', () => {
  it('rejects a non-staff target user', async () => {
    (staffPinRepository.findUserBasic as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u1',
      firstName: 'A',
      lastName: 'B',
      role: ROLES.SUPERVISOR,
      isActive: true,
    });
    await expect(staffPinService.setPin('u1', '1234', actor(ROLES.SUPER_ADMIN), null)).rejects.toMatchObject({ code: 'NOT_STAFF' });
  });

  it('rejects setting a PIN for a deactivated employee', async () => {
    (staffPinRepository.findUserBasic as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u1',
      firstName: 'A',
      lastName: 'B',
      role: ROLES.STAFF,
      isActive: false,
    });
    await expect(staffPinService.setPin('u1', '1234', actor(ROLES.SUPER_ADMIN), null)).rejects.toMatchObject({ code: 'USER_INACTIVE' });
  });

  it('denies branch/supervisor actors outside the staff member\'s branch', async () => {
    (staffPinRepository.findUserBasic as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u1',
      firstName: 'A',
      lastName: 'B',
      role: ROLES.STAFF,
      isActive: true,
    });
    (staffPinRepository.findActiveAssignedBranchIds as ReturnType<typeof vi.fn>).mockResolvedValue(['branch-2']);
    (hasBranchAccess as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(staffPinService.setPin('u1', '1234', actor(ROLES.SUPERVISOR), null)).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED' });
  });

  it('bcrypt-hashes the PIN and HMACs the lookup digest before storing', async () => {
    (staffPinRepository.findUserBasic as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u1',
      firstName: 'A',
      lastName: 'B',
      role: ROLES.STAFF,
      isActive: true,
    });
    (staffPinRepository.findActiveAssignedBranchIds as ReturnType<typeof vi.fn>).mockResolvedValue(['branch-1']);
    (staffPinRepository.upsertPin as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sp1', setAt: new Date('2026-01-01') });
    (staffPinRepository.revokeOutstandingVerifications as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    (staffPinRepository.deleteBranchLookups as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    (staffPinRepository.createBranchLookups as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    const result = await staffPinService.setPin('u1', '1234', actor(ROLES.SUPER_ADMIN), null);

    expect(result.user_id).toBe('u1');
    const upsertCall = (staffPinRepository.upsertPin as ReturnType<typeof vi.fn>).mock.calls[0];
    if (!upsertCall) throw new Error('expected upsertPin to have been called');
    expect(upsertCall[1].pinHash).not.toBe('1234');
    expect(await bcrypt.compare('1234', upsertCall[1].pinHash)).toBe(true);
    // Deterministic digest for the same secret+PIN — same input always HMACs identically.
    expect(upsertCall[1].pinLookupDigest).toHaveLength(64);
  });

  it('maps a branch-collision (P2002) to PIN_ALREADY_IN_USE', async () => {
    (staffPinRepository.findUserBasic as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u1',
      firstName: 'A',
      lastName: 'B',
      role: ROLES.STAFF,
      isActive: true,
    });
    (staffPinRepository.findActiveAssignedBranchIds as ReturnType<typeof vi.fn>).mockResolvedValue(['branch-1']);
    (staffPinRepository.upsertPin as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sp1', setAt: new Date() });
    (staffPinRepository.revokeOutstandingVerifications as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    (staffPinRepository.deleteBranchLookups as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    (staffPinRepository.createBranchLookups as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' }),
    );

    await expect(staffPinService.setPin('u1', '1234', actor(ROLES.SUPER_ADMIN), null)).rejects.toMatchObject({ code: 'PIN_ALREADY_IN_USE' });
  });
});

describe('staffPinService.verifyPin', () => {
  const draft = { branchId: 'branch-1', pin: '1234', operation: 'WASTE' as const, inventoryItemId: 'item-1', quantity: 5 };

  it('returns a generic INVALID_PIN when no branch lookup row matches', async () => {
    (staffPinRepository.findActiveBranchLookup as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(staffPinService.verifyPin(draft, actor(ROLES.BRANCH))).rejects.toMatchObject({ code: 'INVALID_PIN' });
  });

  it('returns a generic INVALID_PIN when the staff pin row is inactive', async () => {
    (staffPinRepository.findActiveBranchLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ staffPinId: 'sp1' });
    (staffPinRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sp1', isActive: false, pinHash: 'x', revokedAt: null });
    await expect(staffPinService.verifyPin(draft, actor(ROLES.BRANCH))).rejects.toMatchObject({ code: 'INVALID_PIN' });
  });

  it('returns a generic INVALID_PIN on a bcrypt mismatch (never reveals which staff it was)', async () => {
    const realHash = await bcrypt.hash('9999', 10);
    (staffPinRepository.findActiveBranchLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ staffPinId: 'sp1' });
    (staffPinRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sp1', isActive: true, pinHash: realHash, revokedAt: null, userId: 'u1' });
    await expect(staffPinService.verifyPin(draft, actor(ROLES.BRANCH))).rejects.toMatchObject({ code: 'INVALID_PIN' });
  });

  it('issues a verification token on a correct PIN and resolves the staff name', async () => {
    const realHash = await bcrypt.hash('1234', 10);
    (staffPinRepository.findActiveBranchLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ staffPinId: 'sp1' });
    (staffPinRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sp1', isActive: true, pinHash: realHash, revokedAt: null, userId: 'u1' });
    (staffPinRepository.findUserBasic as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'u1', firstName: 'Jane', lastName: 'Doe', isActive: true });
    (staffPinRepository.createVerification as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await staffPinService.verifyPin(draft, actor(ROLES.BRANCH));

    expect(result.staff_name).toBe('Jane Doe');
    expect(result.verification_token).toHaveLength(64); // randomOpaqueToken() = 32 bytes hex
    const createCall = (staffPinRepository.createVerification as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(createCall?.tokenDigest).not.toBe(result.verification_token);
  });
});

describe('staffPinService.consumeVerification', () => {
  const baseVerification = {
    id: 'v1',
    staffPinId: 'sp1',
    branchId: 'branch-1',
    purpose: 'inventory',
    operation: 'WASTE',
    inventoryItemId: 'item-1',
    payloadHash: '',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    revokedAt: null,
    createdAt: new Date('2026-01-01'),
  };

  function input(overrides: Partial<Parameters<typeof staffPinService.consumeVerification>[0]> = {}) {
    return {
      token: 'tok',
      actorUserId: 'actor-1',
      branchId: 'branch-1',
      operation: 'WASTE' as const,
      inventoryItemId: 'item-1',
      quantity: 5,
      ...overrides,
    };
  }

  it('rejects when no verification row matches the token', async () => {
    (staffPinRepository.findVerificationByTokenDigest as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(staffPinService.consumeVerification(input())).rejects.toMatchObject({ code: 'VERIFICATION_NOT_FOUND' });
  });

  it('rejects a revoked verification', async () => {
    (staffPinRepository.findVerificationByTokenDigest as ReturnType<typeof vi.fn>).mockResolvedValue({ ...baseVerification, revokedAt: new Date() });
    await expect(staffPinService.consumeVerification(input())).rejects.toMatchObject({ code: 'VERIFICATION_REVOKED' });
  });

  it('rejects an expired verification', async () => {
    (staffPinRepository.findVerificationByTokenDigest as ReturnType<typeof vi.fn>).mockResolvedValue({ ...baseVerification, expiresAt: new Date(Date.now() - 1000) });
    await expect(staffPinService.consumeVerification(input())).rejects.toMatchObject({ code: 'VERIFICATION_EXPIRED' });
  });

  it('rejects a branch/operation/item context mismatch', async () => {
    (staffPinRepository.findVerificationByTokenDigest as ReturnType<typeof vi.fn>).mockResolvedValue(baseVerification);
    await expect(staffPinService.consumeVerification(input({ branchId: 'branch-2' }))).rejects.toMatchObject({ code: 'VERIFICATION_CONTEXT_MISMATCH' });
  });

  it('rejects when the submitted payload no longer matches what was verified', async () => {
    (staffPinRepository.findVerificationByTokenDigest as ReturnType<typeof vi.fn>).mockResolvedValue({ ...baseVerification, payloadHash: 'stale-hash' });
    await expect(staffPinService.consumeVerification(input({ quantity: 999 }))).rejects.toMatchObject({ code: 'VERIFICATION_PAYLOAD_MISMATCH' });
  });

  it('rejects a concurrently-already-consumed token (exactly-once mutex)', async () => {
    const { sha256Hex } = await import('../../lib/hash.js');
    const matchingPayloadHash = sha256Hex(JSON.stringify({ quantity: 5, unitId: null, reasonCode: null, notes: null }));
    (staffPinRepository.findVerificationByTokenDigest as ReturnType<typeof vi.fn>).mockResolvedValue({ ...baseVerification, payloadHash: matchingPayloadHash });
    (staffPinRepository.markConsumedIfUnconsumed as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(staffPinService.consumeVerification(input())).rejects.toMatchObject({ code: 'VERIFICATION_ALREADY_CONSUMED' });
  });

  it('resolves the responsible staff identity on a valid, matching, unconsumed token', async () => {
    const { sha256Hex } = await import('../../lib/hash.js');
    const matchingPayloadHash = sha256Hex(JSON.stringify({ quantity: 5, unitId: null, reasonCode: null, notes: null }));
    (staffPinRepository.findVerificationByTokenDigest as ReturnType<typeof vi.fn>).mockResolvedValue({ ...baseVerification, payloadHash: matchingPayloadHash });
    (staffPinRepository.markConsumedIfUnconsumed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (staffPinRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sp1', userId: 'u1' });
    (staffPinRepository.findUserBasic as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'u1', firstName: 'Jane', lastName: 'Doe' });

    const result = await staffPinService.consumeVerification(input());

    expect(result.responsibleStaffUserId).toBe('u1');
    expect(result.responsibleStaffName).toBe('Jane Doe');
  });
});

describe('staffPinService.revokePin', () => {
  it('throws PIN_NOT_FOUND when the staff member has no active PIN', async () => {
    (staffPinRepository.findByUserId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(staffPinService.revokePin('u1', actor(ROLES.SUPER_ADMIN), null)).rejects.toMatchObject({ code: 'PIN_NOT_FOUND' });
  });

  it('revokes the pin, clears branch lookups, and revokes outstanding verifications', async () => {
    (staffPinRepository.findByUserId as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sp1', isActive: true });
    (staffPinRepository.revoke as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (staffPinRepository.deleteBranchLookups as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (staffPinRepository.revokeOutstandingVerifications as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

    await staffPinService.revokePin('u1', actor(ROLES.SUPER_ADMIN), null);

    expect(staffPinRepository.revoke).toHaveBeenCalledWith('sp1', expect.anything());
    expect(staffPinRepository.deleteBranchLookups).toHaveBeenCalledWith('sp1', expect.anything());
    expect(staffPinRepository.revokeOutstandingVerifications).toHaveBeenCalledWith('sp1', expect.anything());
  });
});

describe('staffPinService.refreshBranchLookupsForUser', () => {
  it('is a no-op when the user has no StaffPin', async () => {
    (staffPinRepository.findByUserId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await staffPinService.refreshBranchLookupsForUser('u1');
    expect(staffPinRepository.deleteBranchLookups).not.toHaveBeenCalled();
  });

  it('re-derives lookup rows from the user\'s current active branch assignments', async () => {
    (staffPinRepository.findByUserId as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sp1', isActive: true, pinLookupDigest: 'digest123' });
    (staffPinRepository.findActiveAssignedBranchIds as ReturnType<typeof vi.fn>).mockResolvedValue(['branch-2']);
    (staffPinRepository.deleteBranchLookups as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (staffPinRepository.createBranchLookups as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    await staffPinService.refreshBranchLookupsForUser('u1');

    expect(staffPinRepository.deleteBranchLookups).toHaveBeenCalledWith('sp1', expect.anything());
    expect(staffPinRepository.createBranchLookups).toHaveBeenCalledWith([{ staffPinId: 'sp1', branchId: 'branch-2', pinLookupDigest: 'digest123' }], expect.anything());
  });

  it('swallows a branch-lookup collision from a newly-assigned branch rather than throwing', async () => {
    (staffPinRepository.findByUserId as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sp1', isActive: true, pinLookupDigest: 'digest123' });
    (staffPinRepository.findActiveAssignedBranchIds as ReturnType<typeof vi.fn>).mockResolvedValue(['branch-2']);
    (staffPinRepository.deleteBranchLookups as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (staffPinRepository.createBranchLookups as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' }),
    );

    await expect(staffPinService.refreshBranchLookupsForUser('u1')).resolves.toBeUndefined();
  });
});
