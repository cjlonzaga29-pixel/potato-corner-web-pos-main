import type { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { ROLES, SOCKET_EVENTS, type BranchStatus, type JwtPayload } from '@potato-corner/shared';
import { branchesRepository } from './branches.repository.js';
import { BranchError, type BranchListFilters, type CreateBranchData, type UpdateBranchData } from './branches.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { getIO } from '../../socket/socket.server.js';
import { SUPER_ADMIN_ROOM } from '../../socket/rooms.js';
import { supabaseAdmin } from '../../lib/supabase.js';

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
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
  user: { id: string; firstName: string; lastName: string; email: string; role: string };
}) {
  return {
    id: assignment.id,
    userId: assignment.userId,
    branchId: assignment.branchId,
    firstName: assignment.user.firstName,
    lastName: assignment.user.lastName,
    email: assignment.user.email,
    role: assignment.user.role,
    assignedAt: assignment.assignedAt.toISOString(),
  };
}

/** super_admin sees everything; supervisor/staff are scoped to their JWT branch_ids — never trust a client-supplied branch list. */
function accessibleBranchIds(requestingUser: JwtPayload): string[] | 'all' {
  if (requestingUser.role === ROLES.SUPER_ADMIN) return 'all';
  return requestingUser.branch_ids;
}

function assertBranchAccess(requestingUser: JwtPayload, branchId: string): void {
  const accessible = accessibleBranchIds(requestingUser);
  if (accessible === 'all') return;
  if (!accessible.includes(branchId)) {
    throw new BranchError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
  }
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
    const accessible = accessibleBranchIds(requestingUser);

    if (branchId) {
      if (accessible !== 'all' && !accessible.includes(branchId)) {
        throw new BranchError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
      }
      const stats = await branchesRepository.branchStats(branchId);
      return [{ branchId, ...stats }];
    }

    const stats = await branchesRepository.findAllStatsGrouped();
    return accessible === 'all' ? stats : stats.filter((s) => accessible.includes(s.branchId));
  },

  async getAllBranches(requestingUser: JwtPayload, filters: BranchListFilters) {
    const accessible = accessibleBranchIds(requestingUser);
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
    assertBranchAccess(requestingUser, branchId);
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

    const branch = await branchesRepository.create({ ...data, code });

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

    return toBranchResponse(branch);
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

    getIO()?.to(SUPER_ADMIN_ROOM).emit(SOCKET_EVENTS.BRANCH_SUPERVISOR_ASSIGNED, { userId, branchId });

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

    getIO()?.to(SUPER_ADMIN_ROOM).emit(SOCKET_EVENTS.BRANCH_SUPERVISOR_REMOVED, { userId, branchId });
  },

  async getAssignments(branchId: string, requestingUser: JwtPayload) {
    assertBranchAccess(requestingUser, branchId);
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    const assignments = await branchesRepository.getActiveAssignments(branchId);
    return assignments.map(toAssignmentResponse);
  },

  async getBranchStats(branchId: string, requestingUser: JwtPayload) {
    assertBranchAccess(requestingUser, branchId);
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    return branchesRepository.branchStats(branchId);
  },
};
