import { IngredientCategory, type Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import sharp from 'sharp';
import { timingSafeEqual } from 'node:crypto';
import {
  ROLES,
  EMPLOYMENT_TYPE,
  SOCKET_EVENTS,
  type BranchDeletionEligibility,
  type BranchDeletionResult,
  type BranchStatus,
  type DeleteBranchInput,
  type JwtPayload,
} from '@potato-corner/shared';
import { branchesRepository } from './branches.repository.js';
import { BranchError, type BranchListFilters, type CreateBranchData, type UpdateBranchData } from './branches.types.js';
import { productInventoryRepository } from '../product-inventory/product-inventory.repository.js';
import { flavorsRepository } from '../flavors/flavors.repository.js';
import { AccountRemovedError, employeesRepository } from '../employees/employees.repository.js';
import { authRepository } from '../auth/auth.repository.js';
import { inventoryService } from '../inventory/inventory.service.js';
import { universalInventoryService } from '../universal-inventory/universal-inventory.service.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { getIO, joinUserToBranchRoom, leaveUserFromBranchRoom } from '../../socket/socket.server.js';
import { SUPER_ADMIN_ROOM, branchRoom, userRoom } from '../../socket/rooms.js';
import { hashField } from '../../lib/encryption.js';
import { forgetAccountStatus } from '../../lib/verify-access-token.js';
import { forgetActiveStatus } from '../../middleware/require-active-employee.js';
import { getBranchPresenceSnapshot } from '../../socket/presence.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { getAccessibleBranchIds, assertBranchAccess } from '../../lib/branch-access.js';
import { prisma } from '../../lib/prisma.js';
import { enqueueNotification } from '../../queues/notification.queue.js';

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

const BCRYPT_COST_FACTOR = 12;

/** Consistent with the check in auth.service.ts's login — a mismatched case/whitespace between account creation and login must never cause a false "Invalid email or password". */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Task 209.x branch-account audit (2026-08-17): tags a `branch` account
 * deactivation as caused by changeBranchStatus itself, not a manual/security
 * disable — the one signal that would let a future branch→active transition
 * tell "safe to auto-reactivate" apart from "an admin disabled this on
 * purpose, leave it alone." Deliberately unused on the reactivation side for
 * now (see the comment in changeBranchStatus) — recorded here so that half
 * of the sync isn't blocked on a schema change later.
 */
const BRANCH_INACTIVE_DEACTIVATION_REASON = 'Auto-deactivated: branch status changed to inactive/closed.';

const STATUS_LABELS: Record<BranchStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  closed: 'Closed',
};

type BranchWithAssignments = Prisma.BranchGetPayload<{
  include: {
    userAssignments: {
      where: { removedAt: null };
      select: {
        id: true;
        userId: true;
        branchId: true;
        assignedAt: true;
        user: { select: { id: true; firstName: true; lastName: true; email: true; role: true } };
      };
    };
  };
}>;

function toBranchResponse(branch: BranchWithAssignments) {
  const activeSupervisorCount = branch.userAssignments.filter((a) => a.user.role === ROLES.SUPERVISOR).length;
  const activeStaffCount = branch.userAssignments.filter((a) => a.user.role === ROLES.STAFF).length;

  return {
    id: branch.id,
    name: branch.name,
    code: branch.code,
    address: branch.address,
    city: branch.city,
    gpsLatitude: branch.gpsLatitude ? branch.gpsLatitude.toNumber() : null,
    gpsLongitude: branch.gpsLongitude ? branch.gpsLongitude.toNumber() : null,
    gpsRadiusMeters: branch.gpsRadiusMeters,
    status: branch.status,
    gcashQrUrl: branch.gcashQrUrl,
    gcashQrKey: branch.gcashQrKey,
    activeSupervisorCount,
    activeStaffCount,
    currentStatusLabel: STATUS_LABELS[branch.status],
    createdAt: branch.createdAt.toISOString(),
    updatedAt: branch.updatedAt.toISOString(),
  };
}

function toAssignmentResponse(assignment: {
  id: string;
  userId: string;
  branchId: string;
  assignedAt: Date;
  user: { id: string; firstName: string; lastName: string; email: string | null; role: string };
}) {
  return {
    id: assignment.id,
    userId: assignment.userId,
    branchId: assignment.branchId,
    firstName: assignment.user.firstName,
    lastName: assignment.user.lastName,
    // Branch assignments are only ever held by supervisor/branch/super_admin
    // accounts (`staff` — Employees — are never directly assigned to a
    // branch this way), and those roles always have an email.
    email: assignment.user.email as string,
    role: assignment.user.role,
    assignedAt: assignment.assignedAt.toISOString(),
  };
}

async function uploadGcashQrToStorage(
  branchId: string,
  file: { buffer: Buffer; originalname: string },
): Promise<{ url: string; key: string }> {
  const compressed = await sharp(file.buffer)
    .resize({ width: 800, withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();

  const path = `branch-gcash-qr/${branchId}/${Date.now()}-${sanitizeFilename(file.originalname)}.webp`;
  const { error } = await supabaseAdmin.storage
    .from('branch-gcash-qr')
    .upload(path, compressed, { contentType: 'image/webp', upsert: true });
  if (error) {
    throw new BranchError('QR_UPLOAD_FAILED', 'Failed to upload the GCash QR image', 502);
  }

  const {
    data: { publicUrl },
  } = supabaseAdmin.storage.from('branch-gcash-qr').getPublicUrl(path);

  return { url: publicUrl, key: path };
}

/** POS-PERF-P67 — names compare ignoring case and extra spaces (same rule as P66 account deletion). */
function normalizeName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-PH');
}

/**
 * POS-PERF-P67 — binds a delete confirmation to the actor who reviewed it,
 * the branch and the version they saw. Keyed with HASH_KEY, so it can only
 * come from this server's deletion-eligibility response.
 */
function branchDeletionToken(actorId: string, branchId: string, version: string): string {
  return hashField(`pos-perf-p67:branch-delete:${actorId}:${branchId}:${version}`);
}

function tokensMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** POS-PERF-P67 — was this branch deleted through the app (only Super Admins delete branches)? */
async function branchDeletedByThisActor(branchId: string, actor: { id: string; role: string }): Promise<boolean> {
  if (actor.role !== ROLES.SUPER_ADMIN) return false;
  const record = await branchesRepository.findRecordById(branchId);
  return Boolean(record?.deletedAt);
}

export const branchesService = {
  /**
   * POS-PERF-P40 — connectivity per branch for the Admin dashboard's Branch
   * Performance table. `available: false` means this process has no socket
   * server, so connectivity is unknown rather than reported as offline.
   */
  async getBranchPresence(requestingUser: JwtPayload) {
    if (requestingUser.role !== ROLES.SUPER_ADMIN) {
      throw new BranchError('BRANCH_ACCESS_DENIED', 'Only super_admin may view cross-branch presence', 403);
    }
    const io = getIO();
    const checkedAt = new Date().toISOString();
    if (!io) return { available: false, checked_at: checkedAt, branches: [] };
    const branches = await branchesRepository.findAllIds();
    return {
      available: true,
      checked_at: checkedAt,
      branches: getBranchPresenceSnapshot(
        io,
        branches.map((b) => b.id),
      ),
    };
  },

  async getAllAccounts(requestingUser: JwtPayload) {
    if (requestingUser.role !== ROLES.SUPER_ADMIN) {
      throw new BranchError('BRANCH_ACCESS_DENIED', 'Only super_admin may view cross-branch accounts', 403);
    }
    const assignments = await branchesRepository.findAllAccounts();
    return assignments.map((a) => ({
      assignment_id: a.id,
      user_id: a.user.id,
      first_name: a.user.firstName,
      last_name: a.user.lastName,
      email: a.user.email,
      role: a.user.role,
      branch_id: a.branch.id,
      branch_name: a.branch.name,
      branch_code: a.branch.code,
    }));
  },

  async getAllBranchStats(requestingUser: JwtPayload, branchId?: string) {
    if (branchId) {
      await assertBranchAccess(requestingUser, branchId, BranchError);
      const stats = await branchesRepository.branchStats(branchId);
      return [{ branchId, ...stats }];
    }

    const accessible = await getAccessibleBranchIds(requestingUser);
    const stats = await branchesRepository.findAllStatsGrouped();
    return accessible === 'all' ? stats : stats.filter((s) => accessible.includes(s.branchId));
  },

  async getAllBranches(requestingUser: JwtPayload, filters: BranchListFilters) {
    const accessible = await getAccessibleBranchIds(requestingUser);
    const effectiveFilters: BranchListFilters = {
      ...filters,
      ...(accessible !== 'all' && { ids: accessible }),
    };

    const { branches, total } = await branchesRepository.findAll(effectiveFilters);
    return {
      branches: branches.map(toBranchResponse),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },

  async getBranchById(branchId: string, requestingUser: JwtPayload) {
    await assertBranchAccess(requestingUser, branchId, BranchError);
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    return toBranchResponse(branch);
  },

  async createBranch(
    data: Omit<CreateBranchData, 'code'> & { code?: string },
    createdBy: { id: string; role: string },
    ipAddress: string | null,
  ) {
    let code = data.code;
    if (code) {
      const existing = await branchesRepository.findByCode(code);
      if (existing) {
        throw new BranchError('BRANCH_CODE_CONFLICT', `Branch code ${code} is already in use`, 409);
      }
      // POS-PERF-P67 — a deleted branch's code stays with its history (receipt
      // numbers and counters carry it), so it is never given to a new branch.
      if (await branchesRepository.findRecordByCode(code)) {
        throw new BranchError('BRANCH_CODE_RETIRED', `Branch code ${code} belonged to a deleted branch and can't be reused`, 409);
      }
    } else {
      code = await branchesRepository.generateBranchCode(data.city);
      // POS-PERF-P67 — skip a generated code that a deleted branch (or a manual code) already holds.
      for (let attempt = 0; attempt < 20 && (await branchesRepository.findRecordByCode(code)); attempt += 1) {
        code = await branchesRepository.generateBranchCode(data.city);
      }
    }

    // Task 174 — branch account creation used to be a second, independent
    // frontend mutation (POST /api/employees) fired after this endpoint
    // returned. If that second call failed for any reason (validation,
    // network, transient error), the branch it created here was already
    // committed and stayed orphaned: visible in Branch Management, absent
    // from Branch Accounts, no way to log in. Folding account creation into
    // this same transaction below closes that gap — either both commit or
    // neither does. Pre-flight checks (email uniqueness, employee ID
    // allocation, password hashing) run here, outside the transaction, for
    // the same reason findByCode/generateBranchCode do: keep the open
    // transaction short, and a wasted employee-ID-counter increment on a
    // pre-flight rejection is an accepted, pre-existing gap (see
    // generateBranchCode's counter, same tradeoff).
    let accountEmail: string | undefined;
    let accountPasswordHash: string | undefined;
    let accountEmployeeId: string | undefined;
    if (data.account) {
      accountEmail = normalizeEmail(data.account.email);
      const existingAccount = await employeesRepository.findByEmail(accountEmail);
      if (existingAccount) {
        throw new BranchError('EMAIL_ALREADY_EXISTS', 'An account with this email already exists', 409);
      }
      accountPasswordHash = await bcrypt.hash(data.account.password, BCRYPT_COST_FACTOR);
      accountEmployeeId = await employeesRepository.generateEmployeeId();
    }

    // Branch creation, account provisioning, identity resolution, and
    // ingredient provisioning all commit atomically — a failure partway
    // through (e.g. provisioning throws) must never leave an orphan branch
    // row with a missing account or an incomplete ingredient set.
    let createdAccountId: string | null = null;

    const branch = await prisma.$transaction(async (tx) => {
      const created = await branchesRepository.create({ ...data, code }, tx);

      if (data.account && accountEmail && accountPasswordHash && accountEmployeeId) {
        const account = await employeesRepository.create(
          {
            email: accountEmail,
            firstName: '',
            lastName: '',
            role: ROLES.BRANCH,
            employmentType: EMPLOYMENT_TYPE.REGULAR,
            branchIds: [created.id],
            employeeId: accountEmployeeId,
            passwordHash: accountPasswordHash,
          },
          tx,
        );
        createdAccountId = account.id;
      }

      // CR-004 idempotent branch provisioning — every ingredient identity an
      // active ProductInventory mapping references gets a zero-stock row
      // here, so a sale at this branch resolves to its own stock instead of
      // leaking against whichever branch's Ingredient the mapping was
      // created against (see recipes.service.ts computeDeduction, which
      // reads ProductInventory, not the legacy Recipe table).
      //
      // CR-005 Sub-phase 3b — unioned with every distinct flavor-derived
      // identity (CR-005 Sub-phase 3a) so a new branch is provisioned for
      // both sources in one pass, closing the inverse of the gap 3a opened:
      // a branch created *after* a flavor existed used to never get that
      // flavor's Ingredient row. Deduped by (name, unit); FLAVOR wins the
      // category on a collision since it's the more specific classification.
      const productInventoryIdentities = await productInventoryRepository.findDistinctIngredientIdentities(tx);
      const flavorIdentities = await flavorsRepository.findDistinctFlavorIngredientIdentities(tx);

      const identityMap = new Map<string, { name: string; unit: string; category: IngredientCategory }>();
      for (const identity of productInventoryIdentities) {
        identityMap.set(`${identity.name}::${identity.unit}`, { ...identity, category: IngredientCategory.OTHER });
      }
      for (const identity of flavorIdentities) {
        identityMap.set(`${identity.name}::${identity.unit}`, { ...identity, category: IngredientCategory.FLAVOR });
      }
      const mergedIdentities = Array.from(identityMap.values());

      if (mergedIdentities.length > 0) {
        await inventoryService.provisionBranchIngredients(created.id, mergedIdentities, tx);
      }

      // The new-model equivalent of the block above: every active,
      // tracked InventoryItem gets a zero-stock InventoryStock row in this
      // branch too, so a Recipe/BOM-ready product is immediately sellable
      // here without a manual inventory-mapping step.
      await universalInventoryService.provisionBranchStock(created.id, tx);

      return created;
    });

    // Post-commit side effects — audit log FK errors are already swallowed
    // by recordAuditLog, and a socket emit is a network side-effect that
    // must never run inside an open DB transaction, so both stay outside it.
    await recordAuditLog({
      action: 'BRANCH_CREATED',
      entityType: 'branch',
      entityId: branch.id,
      actorId: createdBy.id,
      actorRole: createdBy.role,
      branchId: branch.id,
      afterState: { name: branch.name, code: branch.code, city: branch.city, status: branch.status },
      ipAddress,
    });

    if (createdAccountId && accountEmail) {
      // Never logs the password — only that an account was created, its id, and its (non-secret) email.
      await recordAuditLog({
        action: 'BRANCH_ACCOUNT_CREATED',
        entityType: 'user',
        entityId: createdAccountId,
        actorId: createdBy.id,
        actorRole: createdBy.role,
        branchId: branch.id,
        afterState: { email: accountEmail, role: ROLES.BRANCH, branchId: branch.id },
        ipAddress,
      });
    }

    const response = toBranchResponse(branch);
    // No supervisor is assigned yet at creation time, so a branch room has
    // no members to notify — Super Admin is the only audience for this event.
    getIO()?.to(SUPER_ADMIN_ROOM).emit(SOCKET_EVENTS.BRANCH_CREATED, response);

    return response;
  },

  async updateBranch(
    branchId: string,
    data: UpdateBranchData,
    updatedBy: { id: string; role: string },
    ipAddress: string | null,
  ) {
    const before = await branchesRepository.findById(branchId);
    if (!before) throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    const branch = await branchesRepository.update(branchId, data);

    await recordAuditLog({
      action: 'BRANCH_UPDATED',
      entityType: 'branch',
      entityId: branch.id,
      actorId: updatedBy.id,
      actorRole: updatedBy.role,
      branchId: branch.id,
      beforeState: toBranchResponse(before),
      afterState: toBranchResponse(branch),
      ipAddress,
    });

    return toBranchResponse(branch);
  },

  async uploadGcashQr(branchId: string, file: { buffer: Buffer; originalname: string }) {
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    return uploadGcashQrToStorage(branchId, file);
  },

  async changeBranchStatus(
    branchId: string,
    status: BranchStatus,
    changedBy: { id: string; role: string },
    ipAddress: string | null,
  ) {
    const before = await branchesRepository.findById(branchId);
    if (!before) throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    if (status === 'closed' && before.status !== 'closed') {
      const activeShifts = await branchesRepository.countActiveShifts(branchId);
      if (activeShifts > 0) {
        throw new BranchError(
          'BRANCH_HAS_ACTIVE_SHIFTS',
          'Cannot close a branch with active shifts — close all shifts first',
          409,
        );
      }
    }

    const branch = await branchesRepository.update(branchId, { status });

    await recordAuditLog({
      action: 'BRANCH_STATUS_CHANGED',
      entityType: 'branch',
      entityId: branch.id,
      actorId: changedBy.id,
      actorRole: changedBy.role,
      branchId: branch.id,
      beforeState: { status: before.status },
      afterState: { status: branch.status },
      ipAddress,
    });

    // Branch account operational-status sync (Task 209.x audit, 2026-08-17):
    // before this, Branch.status and the canonical role='branch' account's
    // isActive were entirely independent — nothing here ever deactivated a
    // branch account, and auth.service.ts's login only ever checked
    // isActive, not Branch.status (now covered separately by
    // assertBranchAccountOperational in auth.service.ts). This closes the
    // active -> inactive/closed half of that gap.
    //
    // The reverse (inactive -> active reactivating the account) is
    // deliberately NOT implemented here. Doing it safely requires being able
    // to tell "this account is deactivated because I deactivated it right
    // here a moment ago" apart from "an admin deactivated this account for
    // an unrelated, manual/security reason after that" — and the schema has
    // no field for that distinction today. BRANCH_INACTIVE_DEACTIVATION_REASON
    // above exists so a future change can make that distinction (by checking
    // deactivationReason before auto-reactivating) without a migration, but
    // wiring that up is a decision for a human to make explicitly, not an
    // automatic side effect of this fix. Until then, reactivating a branch
    // account after its branch comes back requires a deliberate admin
    // action via the Employees screen.
    if (status !== 'active' && before.status === 'active') {
      const branchAccounts = await branchesRepository.findActiveBranchAccountUsers(branchId);
      for (const account of branchAccounts) {
        await prisma.user.update({
          where: { id: account.id },
          data: {
            isActive: false,
            status: 'inactive',
            deactivatedAt: new Date(),
            deactivatedBy: changedBy.id,
            deactivationReason: BRANCH_INACTIVE_DEACTIVATION_REASON,
          },
        });
        await authRepository.revokeAllUserTokens(account.id);
        await recordAuditLog({
          action: 'BRANCH_ACCOUNT_AUTO_DEACTIVATED',
          entityType: 'user',
          entityId: account.id,
          actorId: changedBy.id,
          actorRole: changedBy.role,
          branchId: branch.id,
          beforeState: { isActive: true },
          afterState: { isActive: false, reason: BRANCH_INACTIVE_DEACTIVATION_REASON },
          ipAddress,
        });
      }
    }

    getIO()?.to(SUPER_ADMIN_ROOM).emit(SOCKET_EVENTS.BRANCH_STATUS_CHANGED, {
      branchId: branch.id,
      status: branch.status,
    });

    // P3D-P6.1 — no persisted Notification previously existed for branch
    // status changes at all (audit gap). Guarded by before.status !== status
    // so a no-op status write (e.g. re-saving 'active') doesn't spam
    // recipients. Recipients resolved via findBranchAllRolesUserIds inside
    // the queue handler, which naturally excludes the branch account this
    // same call may have just deactivated above.
    if (before.status !== branch.status) {
      await enqueueNotification('branch_status_changed', {
        type: 'branch_status_changed',
        branchId: branch.id,
        branchName: branch.name,
        status: branch.status,
        changedByRole: changedBy.role,
      });
    }

    return toBranchResponse(branch);
  },

  /**
   * POS-PERF-P67 — tells the Delete dialog whether the branch can be deleted
   * now, what stays, what goes, and what to type. The confirmation token is
   * issued for this actor, this branch and this version. History never
   * blocks; open work and non-zero stock do.
   */
  async getDeletionEligibility(branchId: string, actor: { id: string; role: string }): Promise<BranchDeletionEligibility> {
    const branch = await branchesRepository.findById(branchId);
    if (!branch) {
      if (await branchDeletedByThisActor(branchId, actor)) {
        return {
          branch_id: branchId,
          can_delete: false,
          blocked_reason: 'already_deleted',
          blockers: [],
          history_retained: null,
          removed: null,
          confirmation: null,
        };
      }
      throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    }
    const [blockers, historyRetained, removed] = await Promise.all([
      branchesRepository.findDeletionBlockers(branchId),
      branchesRepository.countRetainedHistory(branchId),
      branchesRepository.countRemovedWithBranch(branchId),
    ]);
    const version = branch.updatedAt.toISOString();
    return {
      branch_id: branchId,
      can_delete: blockers.length === 0,
      blocked_reason: blockers.length > 0 ? 'open_operations' : null,
      blockers,
      history_retained: historyRetained,
      removed,
      confirmation: {
        name: branch.name,
        code: branch.code,
        version,
        confirmation_token: branchDeletionToken(actor.id, branchId, version),
      },
    };
  },

  /**
   * POS-PERF-P67 — permanent deletion of the operational branch. The branch,
   * its login accounts, everyone's access to it and its configuration go;
   * every sale, shift, attendance record, expense, payroll run, stock
   * movement, proof and audit entry stays, attributed to the branch's
   * historical record (BranchRecord) by its original name and code. The
   * confirmation (typed name and code, version and the server-issued token)
   * is checked here. Open work and non-zero stock block, and nothing changes
   * until they are resolved. A repeat after success reports 'already_deleted'.
   */
  async deleteBranch(
    branchId: string,
    deletedBy: { id: string; role: string },
    ipAddress: string | null,
    confirmation: DeleteBranchInput,
  ): Promise<BranchDeletionResult> {
    const before = await branchesRepository.findById(branchId);
    if (!before) return branchesService.reportRepeatedDeletion(branchId, deletedBy, ipAddress);

    if (normalizeName(confirmation.confirm_name) !== normalizeName(before.name) || confirmation.confirm_code.trim() !== before.code) {
      throw new BranchError(
        'DELETE_CONFIRMATION_MISMATCH',
        `Type the branch name (${before.name}) and code (${before.code}) exactly as shown to confirm.`,
        400,
      );
    }
    const version = new Date(confirmation.version);
    const expectedToken = branchDeletionToken(deletedBy.id, branchId, confirmation.version);
    if (!tokensMatch(expectedToken, confirmation.confirmation_token)) {
      throw new BranchError('DELETE_CONFIRMATION_INVALID', 'This confirmation was not issued to you for this branch. Open Delete again.', 403);
    }
    if (Number.isNaN(version.getTime()) || version.getTime() !== before.updatedAt.getTime()) {
      throw new BranchError('BRANCH_CHANGED', 'This branch changed after the dialog opened. Review the details and confirm again.', 409);
    }

    const historyRetained = await branchesRepository.countRetainedHistory(branchId);
    const result = await branchesRepository.deletePermanently(branchId, deletedBy.id, version);
    if (result.outcome === 'not_found') return branchesService.reportRepeatedDeletion(branchId, deletedBy, ipAddress);
    if (result.outcome === 'changed') {
      throw new BranchError('BRANCH_CHANGED', 'This branch changed after the dialog opened. Review the details and confirm again.', 409);
    }
    if (result.outcome === 'activity') {
      throw new BranchError(
        'BRANCH_ACTIVITY_DURING_DELETE',
        'Someone recorded work at this branch while it was being deleted. Nothing was deleted. Check the branch and try again.',
        409,
      );
    }
    if (result.outcome === 'blocked') {
      throw new BranchError(
        'BRANCH_HAS_OPEN_OPERATIONS',
        `${before.name} can't be deleted yet. ${result.blockers.map((blocker) => blocker.message).join(' ')} Nothing was deleted.`,
        409,
        { blockers: result.blockers },
      );
    }

    // Committed. Sign out the branch's own accounts and drop every socket's
    // subscription to the branch; none of this can undo the deletion.
    try {
      for (const userId of result.branchAccountIds) {
        forgetAccountStatus(userId);
        forgetActiveStatus(userId);
      }
      const io = getIO();
      if (io) {
        for (const userId of result.branchAccountIds) {
          io.to(userRoom(userId)).emit(SOCKET_EVENTS.EMPLOYEE_SESSION_REVOKED, { employeeId: userId, status: 'deleted' });
          void io.in(userRoom(userId)).disconnectSockets(true);
        }
        io.in(branchRoom(branchId)).socketsLeave(branchRoom(branchId));
        io.to(SUPER_ADMIN_ROOM).emit(SOCKET_EVENTS.BRANCH_DELETED, { branchId });
      }
    } catch (error) {
      console.error('Post-deletion session cleanup failed (branch already deleted):', error);
    }

    // The audit entry names the branch: audit_logs references the branch
    // record, which outlives the branch.
    await recordAuditLog({
      action: 'BRANCH_DELETED',
      entityType: 'branch',
      entityId: before.id,
      actorId: deletedBy.id,
      actorRole: deletedBy.role,
      branchId: before.id,
      beforeState: { name: before.name, code: before.code, city: before.city, address: before.address, status: before.status },
      afterState: { deleted: true, history_retained: historyRetained, removed: result.removed, branch_accounts_deleted: result.branchAccountIds },
      ipAddress,
    });

    return { deleted: true, outcome: 'deleted' };
  },

  /**
   * POS-PERF-P67 — the branch is already gone. If this actor deleted it (or
   * any Super Admin asks, since only Super Admins delete branches), the
   * earlier request succeeded and only its response was lost. Otherwise 404.
   */
  async reportRepeatedDeletion(branchId: string, actor: { id: string; role: string }, ipAddress: string | null): Promise<BranchDeletionResult> {
    if (!(await branchDeletedByThisActor(branchId, actor))) {
      throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    }
    await recordAuditLog({
      action: 'BRANCH_DELETION_REPEATED',
      entityType: 'branch',
      entityId: branchId,
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      afterState: { deleted: true },
      ipAddress,
    });
    return { deleted: true, outcome: 'already_deleted' };
  },

  async assignSupervisor(userId: string, branchId: string, assignedBy: { id: string; role: string }, ipAddress: string | null) {
    const user = await branchesRepository.findUserById(userId);
    if (!user) throw new BranchError('USER_NOT_FOUND', 'User not found', 404);
    if (user.role !== ROLES.SUPERVISOR) {
      throw new BranchError('USER_NOT_SUPERVISOR', 'Only users with the supervisor role can be assigned to a branch', 422);
    }
    // POS-PERF-P64 — a removed account never gets branch access back. The
    // repository re-checks under the user's row lock for a racing removal.
    if (user.deletedAt) {
      throw new BranchError('USER_REMOVED', 'This account has been removed and cannot be assigned to a branch', 409);
    }

    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    if (branch.status !== 'active') {
      throw new BranchError('BRANCH_NOT_ACTIVE', 'Cannot assign a supervisor to a non-active branch', 409);
    }

    const existing = await branchesRepository.findActiveAssignment(userId, branchId);
    if (existing) {
      // Idempotent — assigning an already-assigned supervisor is not an error.
      return existing;
    }

    let assignment: Awaited<ReturnType<typeof branchesRepository.assignUser>>;
    try {
      assignment = await branchesRepository.assignUser(userId, branchId);
    } catch (error) {
      if (error instanceof AccountRemovedError) {
        throw new BranchError('USER_REMOVED', 'This account has been removed and cannot be assigned to a branch', 409);
      }
      throw error;
    }

    await recordAuditLog({
      action: 'SUPERVISOR_ASSIGNED',
      entityType: 'user_branch_assignment',
      entityId: assignment.id,
      actorId: assignedBy.id,
      actorRole: assignedBy.role,
      branchId,
      afterState: { userId, branchId },
      ipAddress,
    });

    joinUserToBranchRoom(userId, branchId);
    getIO()?.to([SUPER_ADMIN_ROOM, userRoom(userId)]).emit(SOCKET_EVENTS.BRANCH_SUPERVISOR_ASSIGNED, { userId, branchId });

    return assignment;
  },

  async removeSupervisor(userId: string, branchId: string, removedBy: { id: string; role: string }, ipAddress: string | null) {
    const existing = await branchesRepository.findActiveAssignment(userId, branchId);
    if (!existing) {
      throw new BranchError('ASSIGNMENT_NOT_FOUND', 'No active assignment found for this user at this branch', 404);
    }

    const assignment = await branchesRepository.removeUserAssignment(existing.id);

    await recordAuditLog({
      action: 'SUPERVISOR_REMOVED',
      entityType: 'user_branch_assignment',
      entityId: assignment.id,
      actorId: removedBy.id,
      actorRole: removedBy.role,
      branchId,
      beforeState: { userId, branchId },
      ipAddress,
    });

    leaveUserFromBranchRoom(userId, branchId);
    getIO()?.to([SUPER_ADMIN_ROOM, userRoom(userId)]).emit(SOCKET_EVENTS.BRANCH_SUPERVISOR_REMOVED, { userId, branchId });
  },

  async getAssignments(branchId: string, requestingUser: JwtPayload) {
    await assertBranchAccess(requestingUser, branchId, BranchError);
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    const assignments = await branchesRepository.getActiveAssignments(branchId);
    return assignments.map(toAssignmentResponse);
  },

  async getBranchStats(branchId: string, requestingUser: JwtPayload) {
    await assertBranchAccess(requestingUser, branchId, BranchError);
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    return branchesRepository.branchStats(branchId);
  },
};
