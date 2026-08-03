import { IngredientCategory, type Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import sharp from 'sharp';
import { ROLES, EMPLOYMENT_TYPE, SOCKET_EVENTS, type BranchStatus, type JwtPayload } from '@potato-corner/shared';
import { branchesRepository } from './branches.repository.js';
import { BranchError, type BranchListFilters, type CreateBranchData, type UpdateBranchData } from './branches.types.js';
import { productInventoryRepository } from '../product-inventory/product-inventory.repository.js';
import { flavorsRepository } from '../flavors/flavors.repository.js';
import { employeesRepository } from '../employees/employees.repository.js';
import { inventoryService } from '../inventory/inventory.service.js';
import { universalInventoryService } from '../universal-inventory/universal-inventory.service.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { getIO, joinUserToBranchRoom, leaveUserFromBranchRoom } from '../../socket/socket.server.js';
import { SUPER_ADMIN_ROOM, userRoom } from '../../socket/rooms.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { getAccessibleBranchIds, assertBranchAccess } from '../../lib/branch-access.js';
import { prisma } from '../../lib/prisma.js';

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

const BCRYPT_COST_FACTOR = 12;

/** Consistent with the check in auth.service.ts's login — a mismatched case/whitespace between account creation and login must never cause a false "Invalid email or password". */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

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

export const branchesService = {
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
    } else {
      code = await branchesRepository.generateBranchCode(data.city);
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

  /**
   * Uploads one QR image to every listed branch's own storage key, then
   * persists gcashQrUrl/gcashQrKey per branch — mirroring the two-step
   * upload-then-update flow the single-branch UI already does client-side
   * (upload endpoint + PATCH). Non-fatal per branch: one failure doesn't
   * stop the rest, so the response carries a partial-success shape.
   */
  async bulkAssignGcashQr(
    branchIds: string[],
    file: { buffer: Buffer; originalname: string },
    assignedBy: { id: string; role: string },
    ipAddress: string | null,
  ): Promise<{
    successful: Array<{ branchId: string; gcashQrUrl: string }>;
    failed: Array<{ branchId: string; error: string }>;
  }> {
    const branches = await branchesRepository.findByIds(branchIds);
    const foundIds = new Set(branches.map((b) => b.id));
    const missingIds = branchIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      throw new BranchError('BRANCH_NOT_FOUND', `Branch(es) not found: ${missingIds.join(', ')}`, 404);
    }

    const successful: Array<{ branchId: string; gcashQrUrl: string }> = [];
    const failed: Array<{ branchId: string; error: string }> = [];

    for (const branchId of branchIds) {
      try {
        const { url, key } = await uploadGcashQrToStorage(branchId, file);
        await branchesRepository.update(branchId, { gcashQrUrl: url, gcashQrKey: key });
        successful.push({ branchId, gcashQrUrl: url });
      } catch (error) {
        failed.push({ branchId, error: error instanceof Error ? error.message : 'Upload failed' });
      }
    }

    await recordAuditLog({
      action: 'BULK_GCASH_QR_ASSIGN',
      entityType: 'branch',
      entityId: branchIds.join(','),
      actorId: assignedBy.id,
      actorRole: assignedBy.role,
      afterState: { branchIds, successCount: successful.length, failureCount: failed.length },
      ipAddress,
    });

    return { successful, failed };
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

    getIO()?.to(SUPER_ADMIN_ROOM).emit(SOCKET_EVENTS.BRANCH_STATUS_CHANGED, {
      branchId: branch.id,
      status: branch.status,
    });

    return toBranchResponse(branch);
  },

  async deleteBranch(branchId: string, deletedBy: { id: string; role: string }, ipAddress: string | null) {
    const before = await branchesRepository.findById(branchId);
    if (!before) throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    const activeShifts = await branchesRepository.countActiveShifts(branchId);
    if (activeShifts > 0) {
      throw new BranchError(
        'BRANCH_HAS_ACTIVE_SHIFTS',
        'Cannot permanently delete a branch with active shifts — close all shifts first',
        409,
      );
    }

    await branchesRepository.delete(branchId);

    // branchId is intentionally omitted (not before.id): the branch row is
    // already gone by this point, and AuditLog.branchId is a real FK — an
    // insert referencing a now-deleted branch id would violate that
    // constraint and be silently swallowed by recordAuditLog's try/catch,
    // meaning no audit entry would ever be written for a successful delete.
    // entityId (not a FK, just an indexed string) still identifies the
    // deleted branch for lookups.
    await recordAuditLog({
      action: 'BRANCH_DELETED',
      entityType: 'branch',
      entityId: before.id,
      actorId: deletedBy.id,
      actorRole: deletedBy.role,
      beforeState: { name: before.name, code: before.code, city: before.city, status: before.status },
      ipAddress,
    });

    getIO()?.to(SUPER_ADMIN_ROOM).emit(SOCKET_EVENTS.BRANCH_DELETED, { branchId });
  },

  async assignSupervisor(userId: string, branchId: string, assignedBy: { id: string; role: string }, ipAddress: string | null) {
    const user = await branchesRepository.findUserById(userId);
    if (!user) throw new BranchError('USER_NOT_FOUND', 'User not found', 404);
    if (user.role !== ROLES.SUPERVISOR) {
      throw new BranchError('USER_NOT_SUPERVISOR', 'Only users with the supervisor role can be assigned to a branch', 422);
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

    const assignment = await branchesRepository.assignUser(userId, branchId);

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
