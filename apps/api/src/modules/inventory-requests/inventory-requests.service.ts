import type { Prisma } from '@prisma/client';
import { ROLES, REQUEST_STATUS, SOCKET_EVENTS, type JwtPayload } from '@potato-corner/shared';
import { inventoryRequestsRepository } from './inventory-requests.repository.js';
import { InventoryRequestError, type InventoryRequestKind } from './inventory-requests.types.js';
import { employeesRepository } from '../employees/employees.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { notifySuperAdmin, notifyBranch } from '../../lib/notify.js';

interface RequestRow {
  id: string;
  branchId: string;
  ingredientId: string;
  type: InventoryRequestKind;
  quantity: Prisma.Decimal;
  reason: string;
  status: string;
  requestedById: string;
  requestedByName: string;
  approvedById: string | null;
  approvedByName: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  branch: { id: string; name: string };
  ingredient: { id: string; name: string };
}

function toResponse(row: RequestRow) {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    ingredientId: row.ingredientId,
    ingredientName: row.ingredient.name,
    type: row.type,
    quantity: row.quantity.toNumber(),
    reason: row.reason,
    status: row.status,
    requestedById: row.requestedById,
    requestedByName: row.requestedByName,
    approvedById: row.approvedById,
    approvedByName: row.approvedByName,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
  };
}

interface CreateInventoryRequestInput {
  branchId: string;
  ingredientId: string;
  type: InventoryRequestKind;
  quantity: number;
  reason: string;
}

async function resolveActorName(userId: string): Promise<string> {
  const user = await employeesRepository.findById(userId);
  if (!user) throw new InventoryRequestError('USER_NOT_FOUND', 'Acting user not found', 404);
  return `${user.firstName} ${user.lastName}`;
}

export const inventoryRequestsService = {
  /** Router gates the role (super_admin or supervisor); supervisors are further scoped to their own assigned branches. */
  async submitRequest(data: CreateInventoryRequestInput, actor: JwtPayload, ipAddress: string | null) {
    if (actor.role === ROLES.SUPERVISOR && !actor.branch_ids.includes(data.branchId)) {
      throw new InventoryRequestError('BRANCH_ACCESS_DENIED', 'You may only submit requests for your own assigned branches', 403);
    }

    const requestedByName = await resolveActorName(actor.user_id);

    const created = (await inventoryRequestsRepository.create({
      branchId: data.branchId,
      ingredientId: data.ingredientId,
      type: data.type,
      quantity: data.quantity,
      reason: data.reason,
      requestedById: actor.user_id,
      requestedByName,
    })) as RequestRow;
    const response = toResponse(created);

    await recordAuditLog({
      action: 'INVENTORY_REQUEST_SUBMITTED',
      entityType: 'inventory_request',
      entityId: created.id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: data.branchId,
      afterState: response,
      ipAddress,
    });

    notifySuperAdmin(SOCKET_EVENTS.INVENTORY_REQUEST_SUBMITTED, response);
    notifyBranch(data.branchId, SOCKET_EVENTS.INVENTORY_REQUEST_SUBMITTED, response);

    return response;
  },

  /** super_admin sees pending requests for every branch; supervisor is scoped to their own branch_ids. */
  async listPending(actor: JwtPayload) {
    const branchIds = actor.role === ROLES.SUPERVISOR ? actor.branch_ids : undefined;
    const rows = (await inventoryRequestsRepository.findPending(branchIds)) as RequestRow[];
    return { requests: rows.map(toResponse) };
  },

  async approveRequest(id: string, actor: JwtPayload, ipAddress: string | null) {
    const request = (await inventoryRequestsRepository.findById(id)) as RequestRow | null;
    if (!request) throw new InventoryRequestError('INVENTORY_REQUEST_NOT_FOUND', 'Inventory request not found', 404);
    if (actor.role === ROLES.SUPERVISOR && !actor.branch_ids.includes(request.branchId)) {
      throw new InventoryRequestError('BRANCH_ACCESS_DENIED', 'You may only act on requests for your own assigned branches', 403);
    }
    if (request.status !== REQUEST_STATUS.PENDING) {
      throw new InventoryRequestError('INVENTORY_REQUEST_ALREADY_REVIEWED', 'This request has already been reviewed', 409);
    }

    const approvedByName = await resolveActorName(actor.user_id);

    const { request: updated } = await inventoryRequestsRepository.approve(id, {
      branchId: request.branchId,
      ingredientId: request.ingredientId,
      type: request.type,
      quantity: request.quantity,
      reason: request.reason,
      requestedById: request.requestedById,
      approvedById: actor.user_id,
      approvedByName,
    });
    const response = toResponse(updated as RequestRow);

    await recordAuditLog({
      action: 'INVENTORY_REQUEST_APPROVED',
      entityType: 'inventory_request',
      entityId: id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: request.branchId,
      beforeState: toResponse(request),
      afterState: response,
      ipAddress,
    });

    notifyBranch(request.branchId, SOCKET_EVENTS.INVENTORY_REQUEST_APPROVED, response);
    return response;
  },

  async rejectRequest(id: string, data: { rejectionReason: string }, actor: JwtPayload, ipAddress: string | null) {
    const request = (await inventoryRequestsRepository.findById(id)) as RequestRow | null;
    if (!request) throw new InventoryRequestError('INVENTORY_REQUEST_NOT_FOUND', 'Inventory request not found', 404);
    if (actor.role === ROLES.SUPERVISOR && !actor.branch_ids.includes(request.branchId)) {
      throw new InventoryRequestError('BRANCH_ACCESS_DENIED', 'You may only act on requests for your own assigned branches', 403);
    }
    if (request.status !== REQUEST_STATUS.PENDING) {
      throw new InventoryRequestError('INVENTORY_REQUEST_ALREADY_REVIEWED', 'This request has already been reviewed', 409);
    }

    const approvedByName = await resolveActorName(actor.user_id);

    const updated = (await inventoryRequestsRepository.reject(id, {
      approvedById: actor.user_id,
      approvedByName,
      rejectionReason: data.rejectionReason,
    })) as RequestRow;
    const response = toResponse(updated);

    await recordAuditLog({
      action: 'INVENTORY_REQUEST_REJECTED',
      entityType: 'inventory_request',
      entityId: id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: request.branchId,
      beforeState: toResponse(request),
      afterState: response,
      ipAddress,
    });

    notifyBranch(request.branchId, SOCKET_EVENTS.INVENTORY_REQUEST_REJECTED, response);
    return response;
  },
};
