import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * All Prisma calls for POS-PERF-P29's StaffPin/StaffPinBranchLookup/
 * StaffPinVerification/InventoryOperationAttempt/InventoryEvidenceUpload
 * tables live here — router/service never call Prisma directly.
 */
export const staffPinRepository = {
  findByUserId(userId: string, tx?: Prisma.TransactionClient) {
    return (tx ?? prisma).staffPin.findUnique({ where: { userId } });
  },

  findById(id: string, tx?: Prisma.TransactionClient) {
    return (tx ?? prisma).staffPin.findUnique({ where: { id } });
  },

  /** Create-or-reinstate: a user's StaffPin row is 1:1 for life — a reset reuses the same row rather than inserting a second one. */
  upsertPin(
    userId: string,
    data: { pinHash: string; pinLookupDigest: string; setByUserId: string },
    tx: Prisma.TransactionClient,
  ) {
    return tx.staffPin.upsert({
      where: { userId },
      create: { userId, pinHash: data.pinHash, pinLookupDigest: data.pinLookupDigest, setByUserId: data.setByUserId, isActive: true },
      update: { pinHash: data.pinHash, pinLookupDigest: data.pinLookupDigest, setByUserId: data.setByUserId, isActive: true, setAt: new Date(), revokedAt: null },
    });
  },

  revoke(staffPinId: string, tx: Prisma.TransactionClient) {
    return tx.staffPin.update({ where: { id: staffPinId }, data: { isActive: false, revokedAt: new Date() } });
  },

  deleteBranchLookups(staffPinId: string, tx: Prisma.TransactionClient) {
    return tx.staffPinBranchLookup.deleteMany({ where: { staffPinId } });
  },

  /**
   * Insert one lookup row per currently-active branch assignment. The
   * @@unique([branchId, pinLookupDigest]) constraint on this table is what
   * makes "no two active staff in the same branch share a PIN" atomic —
   * this call can throw Prisma's P2002 on a collision, which the caller
   * (service.ts#setPin) maps to a domain error.
   */
  createBranchLookups(rows: { staffPinId: string; branchId: string; pinLookupDigest: string }[], tx: Prisma.TransactionClient) {
    if (rows.length === 0) return Promise.resolve({ count: 0 });
    return tx.staffPinBranchLookup.createMany({ data: rows });
  },

  findActiveBranchLookup(branchId: string, pinLookupDigest: string) {
    return prisma.staffPinBranchLookup.findUnique({
      where: { branchId_pinLookupDigest: { branchId, pinLookupDigest } },
    });
  },

  /** Active (removedAt IS NULL) branch assignments for a user — same convention as employees.repository.ts's own branch-assignment reads. */
  async findActiveAssignedBranchIds(userId: string): Promise<string[]> {
    const rows = await prisma.userBranchAssignment.findMany({
      where: { userId, removedAt: null },
      select: { branchId: true },
    });
    return rows.map((r) => r.branchId);
  },

  createVerification(
    input: {
      tokenDigest: string;
      staffPinId: string;
      verifiedByActorUserId: string;
      branchId: string;
      operation: string;
      inventoryItemId?: string | null;
      payloadHash: string;
      expiresAt: Date;
    },
    tx?: Prisma.TransactionClient,
  ) {
    return (tx ?? prisma).staffPinVerification.create({
      data: {
        tokenDigest: input.tokenDigest,
        staffPinId: input.staffPinId,
        verifiedByActorUserId: input.verifiedByActorUserId,
        branchId: input.branchId,
        operation: input.operation as Prisma.StaffPinVerificationCreateInput['operation'],
        inventoryItemId: input.inventoryItemId ?? null,
        payloadHash: input.payloadHash,
        expiresAt: input.expiresAt,
      },
    });
  },

  findVerificationByTokenDigest(tokenDigest: string, tx?: Prisma.TransactionClient) {
    return (tx ?? prisma).staffPinVerification.findUnique({ where: { tokenDigest } });
  },

  /** Exactly-once consume mutex — same conditional-UPDATE idiom as inventory-approval.repository's markApprovedIfPending. */
  async markConsumedIfUnconsumed(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const { count } = await tx.staffPinVerification.updateMany({
      where: { id, consumedAt: null, revokedAt: null },
      data: { consumedAt: new Date() },
    });
    return count === 1;
  },

  /** PIN reset/revoke invalidates every outstanding (unconsumed, unexpired or not) token issued under the old hash — a leaked token minted before a reset must never still work after it. */
  revokeOutstandingVerifications(staffPinId: string, tx: Prisma.TransactionClient) {
    return tx.staffPinVerification.updateMany({
      where: { staffPinId, consumedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  findUserBasic(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, select: { id: true, firstName: true, lastName: true, role: true, isActive: true } });
  },

  // --- InventoryEvidenceUpload (pre-submit blocking evidence) ---

  createEvidence(input: { branchId: string; uploadedByUserId: string; storageKey: string; proofType: string; expiresAt: Date }) {
    return prisma.inventoryEvidenceUpload.create({
      data: {
        branchId: input.branchId,
        uploadedByUserId: input.uploadedByUserId,
        storageKey: input.storageKey,
        proofType: input.proofType as Prisma.InventoryEvidenceUploadCreateInput['proofType'],
        expiresAt: input.expiresAt,
      },
    });
  },

  findEvidenceById(id: string) {
    return prisma.inventoryEvidenceUpload.findUnique({ where: { id } });
  },

  /** Exactly-once consume mutex, same idiom as markConsumedIfUnconsumed above. */
  async markEvidenceConsumedIfUnconsumed(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const { count } = await tx.inventoryEvidenceUpload.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return count === 1;
  },

  /** Abandoned (never consumed, past TTL) evidence rows — swept periodically; never touches a row with consumedAt set. */
  findExpiredUnconsumedEvidence(now: Date, limit: number) {
    return prisma.inventoryEvidenceUpload.findMany({
      where: { consumedAt: null, expiresAt: { lt: now } },
      take: limit,
    });
  },

  deleteEvidenceRows(ids: string[]) {
    if (ids.length === 0) return Promise.resolve({ count: 0 });
    return prisma.inventoryEvidenceUpload.deleteMany({ where: { id: { in: ids } } });
  },
};
