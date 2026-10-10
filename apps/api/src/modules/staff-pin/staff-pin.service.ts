import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { ROLES, type JwtPayload } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config/index.js';
import { hmacSha256Hex, sha256Hex, randomOpaqueToken } from '../../lib/hash.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { hasBranchAccess } from '../../lib/branch-access.js';
import { staffPinRepository } from './staff-pin.repository.js';
import {
  StaffPinError,
  type ConsumeVerificationInput,
  type ConsumedVerification,
  type VerifyPinDraft,
  type VerifyPosPinDraft,
  type ConsumePosVerificationInput,
} from './staff-pin.types.js';

const BCRYPT_COST_FACTOR = 12;
const VERIFICATION_TTL_MS = 5 * 60 * 1000;

function hmacPin(pin: string): string {
  return hmacSha256Hex(config.staffPinHmacSecret, pin);
}

/**
 * Canonical payload binding for a verification token — the exact fields
 * that can change between "verify" and "submit" and must invalidate the
 * token if they do. Field order is fixed so the hash is stable.
 */
function hashPayload(input: { quantity?: number; unitId?: string; reasonCode?: string; notes?: string }): string {
  return sha256Hex(
    JSON.stringify({
      quantity: input.quantity ?? null,
      unitId: input.unitId ?? null,
      reasonCode: input.reasonCode ?? null,
      notes: input.notes ?? null,
    }),
  );
}

export const staffPinService = {
  /**
   * Set or reset a staff member's PIN. Called either by a supervisor/admin
   * provisioning/resetting another staff member's PIN, or by the staff
   * member themselves via the restricted self-service route (router enforces
   * actor.user_id === userId for that path, and that the actor currently has
   * an active branch session — same gate as auth.service.ts#setPin for
   * PinCredential). Re-derives the lookup rows from the user's CURRENT
   * active branch assignments every time, so a reset after a branch
   * transfer never leaves a stale lookup pointing at the old branch.
   */
  async setPin(userId: string, pin: string, actor: JwtPayload, ipAddress: string | null): Promise<{ user_id: string; set_at: string }> {
    const target = await staffPinRepository.findUserBasic(userId);
    if (!target) throw new StaffPinError('USER_NOT_FOUND', 'Staff member not found', 404);
    if (target.role !== ROLES.STAFF) {
      throw new StaffPinError('NOT_STAFF', 'A staff PIN can only be set for a staff-role employee', 400);
    }
    if (!target.isActive) {
      throw new StaffPinError('USER_INACTIVE', 'Cannot set a PIN for a deactivated employee', 409);
    }

    const branchIds = await staffPinRepository.findActiveAssignedBranchIds(userId);
    // branch/supervisor may only provision a PIN for staff within their own
    // accessible branch(es) — a STAFF role always has exactly one active
    // assignment (enforced at employees.service.ts), so this is a single
    // check, not a loop over multiple branches.
    if (actor.role !== ROLES.SUPER_ADMIN) {
      const assignedBranchId = branchIds[0];
      if (!assignedBranchId || !(await hasBranchAccess(actor, assignedBranchId))) {
        throw new StaffPinError('BRANCH_ACCESS_DENIED', 'You do not have access to this staff member\'s branch', 403);
      }
    }
    const pinHash = await bcrypt.hash(pin, BCRYPT_COST_FACTOR);
    const pinLookupDigest = hmacPin(pin);

    const result = await prisma.$transaction(async (tx) => {
      const staffPin = await staffPinRepository.upsertPin(userId, { pinHash, pinLookupDigest, setByUserId: actor.user_id }, tx);
      await staffPinRepository.revokeOutstandingVerifications(staffPin.id, tx);
      await staffPinRepository.deleteBranchLookups(staffPin.id, tx);
      if (branchIds.length > 0) {
        try {
          await staffPinRepository.createBranchLookups(
            branchIds.map((branchId) => ({ staffPinId: staffPin.id, branchId, pinLookupDigest })),
            tx,
          );
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new StaffPinError(
              'PIN_ALREADY_IN_USE',
              'This PIN is already in use by another active staff member at one of this employee\'s branches — choose a different PIN',
              409,
            );
          }
          throw error;
        }
      }
      return staffPin;
    });

    await recordAuditLog({
      action: 'STAFF_PIN_SET',
      entityType: 'staff_pin',
      entityId: result.id,
      actorId: actor.user_id,
      actorRole: actor.role,
      afterState: { userId, branchCount: branchIds.length },
      ipAddress,
    });

    return { user_id: userId, set_at: result.setAt.toISOString() };
  },

  async getStatus(userId: string): Promise<{ user_id: string; has_pin: boolean; is_active: boolean; set_at: string | null }> {
    const staffPin = await staffPinRepository.findByUserId(userId);
    return {
      user_id: userId,
      has_pin: staffPin !== null,
      is_active: staffPin?.isActive ?? false,
      set_at: staffPin?.setAt.toISOString() ?? null,
    };
  },

  async revokePin(userId: string, actor: JwtPayload, ipAddress: string | null): Promise<void> {
    const staffPin = await staffPinRepository.findByUserId(userId);
    if (!staffPin || !staffPin.isActive) {
      throw new StaffPinError('PIN_NOT_FOUND', 'This employee has no active PIN to revoke', 404);
    }
    if (actor.role !== ROLES.SUPER_ADMIN) {
      const branchIds = await staffPinRepository.findActiveAssignedBranchIds(userId);
      const assignedBranchId = branchIds[0];
      if (!assignedBranchId || !(await hasBranchAccess(actor, assignedBranchId))) {
        throw new StaffPinError('BRANCH_ACCESS_DENIED', 'You do not have access to this staff member\'s branch', 403);
      }
    }

    await prisma.$transaction(async (tx) => {
      await staffPinRepository.revoke(staffPin.id, tx);
      await staffPinRepository.deleteBranchLookups(staffPin.id, tx);
      await staffPinRepository.revokeOutstandingVerifications(staffPin.id, tx);
    });

    await recordAuditLog({
      action: 'STAFF_PIN_REVOKED',
      entityType: 'staff_pin',
      entityId: staffPin.id,
      actorId: actor.user_id,
      actorRole: actor.role,
      afterState: { userId },
      ipAddress,
    });
  },

  /**
   * Resolve a PIN to a staff identity and issue a short-lived, single-use
   * verification token bound to the exact operation draft. Never reveals
   * WHICH staff member a wrong/inactive/cross-branch PIN belonged to — every
   * failure path throws the same generic INVALID_PIN.
   */
  async verifyPin(draft: VerifyPinDraft, actor: JwtPayload): Promise<{ staff_name: string; verification_token: string; expires_at: string }> {
    const digest = hmacPin(draft.pin);
    const lookup = await staffPinRepository.findActiveBranchLookup(draft.branchId, digest);
    if (!lookup) {
      throw new StaffPinError('INVALID_PIN', 'Invalid PIN', 401);
    }

    const staffPin = await staffPinRepository.findById(lookup.staffPinId);
    if (!staffPin || !staffPin.isActive || staffPin.revokedAt) {
      throw new StaffPinError('INVALID_PIN', 'Invalid PIN', 401);
    }

    const matches = await bcrypt.compare(draft.pin, staffPin.pinHash);
    if (!matches) {
      throw new StaffPinError('INVALID_PIN', 'Invalid PIN', 401);
    }

    const user = await staffPinRepository.findUserBasic(staffPin.userId);
    if (!user || !user.isActive) {
      throw new StaffPinError('INVALID_PIN', 'Invalid PIN', 401);
    }

    const token = randomOpaqueToken();
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
    await staffPinRepository.createVerification({
      tokenDigest: sha256Hex(token),
      staffPinId: staffPin.id,
      verifiedByActorUserId: actor.user_id,
      branchId: draft.branchId,
      purpose: 'inventory',
      operation: draft.operation,
      inventoryItemId: draft.inventoryItemId ?? null,
      payloadHash: hashPayload(draft),
      expiresAt,
    });

    return {
      staff_name: `${user.firstName} ${user.lastName}`,
      verification_token: token,
      expires_at: expiresAt.toISOString(),
    };
  },

  /**
   * Validate and atomically consume a verification token against the
   * submitted operation body. Throws a distinct, actionable error for each
   * failure mode (not found / revoked / expired / wrong context / payload
   * changed / already consumed) rather than one generic rejection, since
   * these surface directly to the submitting UI (e.g. "relevant form
   * changes require fresh verification").
   */
  async consumeVerification(input: ConsumeVerificationInput): Promise<ConsumedVerification> {
    const tokenDigest = sha256Hex(input.token);
    const verification = await staffPinRepository.findVerificationByTokenDigest(tokenDigest);
    if (!verification) {
      throw new StaffPinError('VERIFICATION_NOT_FOUND', 'PIN verification not found — please verify again', 422);
    }
    if (verification.revokedAt) {
      throw new StaffPinError('VERIFICATION_REVOKED', 'This PIN verification was revoked — please verify again', 422);
    }
    if (verification.expiresAt.getTime() < Date.now()) {
      throw new StaffPinError('VERIFICATION_EXPIRED', 'This PIN verification has expired — please verify again', 422);
    }
    // POS-PERF-P30 -- purpose separation: an inventory-purpose consume must
    // never accept a `pos`-purpose token (and consumePosVerification below
    // enforces the mirror image), even if every other field happens to line
    // up (same branch/actor).
    if (verification.purpose !== 'inventory') {
      throw new StaffPinError('VERIFICATION_CONTEXT_MISMATCH', 'This PIN verification does not match this operation — please verify again', 422);
    }
    if (verification.branchId !== input.branchId || verification.operation !== input.operation) {
      throw new StaffPinError('VERIFICATION_CONTEXT_MISMATCH', 'This PIN verification does not match this operation — please verify again', 422);
    }
    if ((verification.inventoryItemId ?? null) !== (input.inventoryItemId ?? null)) {
      throw new StaffPinError('VERIFICATION_CONTEXT_MISMATCH', 'This PIN verification does not match this item — please verify again', 422);
    }
    const payloadHash = hashPayload(input);
    if (payloadHash !== verification.payloadHash) {
      throw new StaffPinError('VERIFICATION_PAYLOAD_MISMATCH', 'This form changed since it was verified — please verify again', 422);
    }

    const consumed = await prisma.$transaction((tx) => staffPinRepository.markConsumedIfUnconsumed(verification.id, tx));
    if (!consumed) {
      throw new StaffPinError('VERIFICATION_ALREADY_CONSUMED', 'This PIN verification has already been used — please verify again', 422);
    }

    const staffPin = await staffPinRepository.findById(verification.staffPinId);
    if (!staffPin) throw new StaffPinError('VERIFICATION_NOT_FOUND', 'PIN verification not found — please verify again', 422);
    const user = await staffPinRepository.findUserBasic(staffPin.userId);
    if (!user) throw new StaffPinError('VERIFICATION_NOT_FOUND', 'PIN verification not found — please verify again', 422);

    return {
      responsibleStaffUserId: user.id,
      responsibleStaffName: `${user.firstName} ${user.lastName}`,
      pinVerifiedAt: verification.createdAt,
    };
  },

  /**
   * POS-PERF-P30 -- resolve a PIN to a staff identity for POS terminal
   * cashier identification / clock-in, under its own `pos` purpose so the
   * resulting token can never be replayed against an inventory operation
   * (consumeVerification above hard-rejects it, and vice versa in
   * consumePosVerification below). Same generic-failure contract as
   * verifyPin: every rejection path is INVALID_PIN, never revealing which
   * staff member (if any) the PIN belonged to.
   */
  async verifyPosPin(draft: VerifyPosPinDraft, actor: JwtPayload): Promise<{ staff_name: string; verification_token: string; expires_at: string }> {
    const digest = hmacPin(draft.pin);
    const lookup = await staffPinRepository.findActiveBranchLookup(draft.branchId, digest);
    if (!lookup) {
      throw new StaffPinError('INVALID_PIN', 'Invalid PIN', 401);
    }

    const staffPin = await staffPinRepository.findById(lookup.staffPinId);
    if (!staffPin || !staffPin.isActive || staffPin.revokedAt) {
      throw new StaffPinError('INVALID_PIN', 'Invalid PIN', 401);
    }

    const matches = await bcrypt.compare(draft.pin, staffPin.pinHash);
    if (!matches) {
      throw new StaffPinError('INVALID_PIN', 'Invalid PIN', 401);
    }

    const user = await staffPinRepository.findUserBasic(staffPin.userId);
    if (!user || !user.isActive) {
      throw new StaffPinError('INVALID_PIN', 'Invalid PIN', 401);
    }

    const token = randomOpaqueToken();
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
    await staffPinRepository.createVerification({
      tokenDigest: sha256Hex(token),
      staffPinId: staffPin.id,
      verifiedByActorUserId: actor.user_id,
      branchId: draft.branchId,
      purpose: 'pos',
      operation: null,
      inventoryItemId: null,
      payloadHash: hashPayload({}),
      expiresAt,
    });

    return {
      staff_name: `${user.firstName} ${user.lastName}`,
      verification_token: token,
      expires_at: expiresAt.toISOString(),
    };
  },

  /**
   * Validate and atomically consume a `pos`-purpose verification token,
   * resolving it to the staff identity it was issued for. Used by
   * auth.service.ts#selectEmployee as the sole source of the Employee id it
   * mints a session for — the caller never supplies employeeId directly.
   */
  async consumePosVerification(input: ConsumePosVerificationInput): Promise<ConsumedVerification> {
    const tokenDigest = sha256Hex(input.token);
    const verification = await staffPinRepository.findVerificationByTokenDigest(tokenDigest);
    if (!verification) {
      throw new StaffPinError('VERIFICATION_NOT_FOUND', 'PIN verification not found — please verify again', 422);
    }
    if (verification.revokedAt) {
      throw new StaffPinError('VERIFICATION_REVOKED', 'This PIN verification was revoked — please verify again', 422);
    }
    if (verification.expiresAt.getTime() < Date.now()) {
      throw new StaffPinError('VERIFICATION_EXPIRED', 'This PIN verification has expired — please verify again', 422);
    }
    if (verification.purpose !== 'pos') {
      throw new StaffPinError('VERIFICATION_CONTEXT_MISMATCH', 'This PIN verification does not match this operation — please verify again', 422);
    }
    if (verification.branchId !== input.branchId) {
      throw new StaffPinError('VERIFICATION_CONTEXT_MISMATCH', 'This PIN verification does not match this branch — please verify again', 422);
    }

    const consumed = await prisma.$transaction((tx) => staffPinRepository.markConsumedIfUnconsumed(verification.id, tx));
    if (!consumed) {
      throw new StaffPinError('VERIFICATION_ALREADY_CONSUMED', 'This PIN verification has already been used — please verify again', 422);
    }

    const staffPin = await staffPinRepository.findById(verification.staffPinId);
    if (!staffPin) throw new StaffPinError('VERIFICATION_NOT_FOUND', 'PIN verification not found — please verify again', 422);
    const user = await staffPinRepository.findUserBasic(staffPin.userId);
    if (!user) throw new StaffPinError('VERIFICATION_NOT_FOUND', 'PIN verification not found — please verify again', 422);

    return {
      responsibleStaffUserId: user.id,
      responsibleStaffName: `${user.firstName} ${user.lastName}`,
      pinVerifiedAt: verification.createdAt,
    };
  },

  /**
   * Re-derive this user's StaffPinBranchLookup rows from scratch against
   * their CURRENT active UserBranchAssignment rows. Called from
   * employees.service.ts after any branch-assignment change (update,
   * deactivate, reactivate, status change) — a no-op if the user has no
   * StaffPin. Never touches StaffPin.pinHash/pinLookupDigest itself, only
   * which branches it's currently looked-up under.
   */
  async refreshBranchLookupsForUser(userId: string): Promise<void> {
    const staffPin = await staffPinRepository.findByUserId(userId);
    if (!staffPin || !staffPin.isActive) return;
    const branchIds = await staffPinRepository.findActiveAssignedBranchIds(userId);
    await prisma.$transaction(async (tx) => {
      await staffPinRepository.deleteBranchLookups(staffPin.id, tx);
      if (branchIds.length === 0) return;
      try {
        await staffPinRepository.createBranchLookups(
          branchIds.map((branchId) => ({ staffPinId: staffPin.id, branchId, pinLookupDigest: staffPin.pinLookupDigest })),
          tx,
        );
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          // A newly-assigned branch already has another active staff member
          // using this exact PIN — surfacing this as a hard failure would
          // block the unrelated branch-assignment change entirely,  worse
          // than silently omitting just that one branch's lookup row. The
          // affected staff member simply can't be PIN-verified at that one
          // branch until one of the two resets their PIN — not a stock
          // write ever happens incorrectly either way.
          console.error(`StaffPinBranchLookup collision while refreshing lookups for user ${userId} — one branch assignment's lookup row was skipped`);
          return;
        }
        throw error;
      }
    });
  },
};
