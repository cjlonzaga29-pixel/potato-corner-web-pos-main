import { Prisma } from '@prisma/client';
import { MOVEMENT_TYPE } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import type { ApproveInventoryRequestData, CreateInventoryRequestData, RejectInventoryRequestData } from './inventory-requests.types.js';

const detailInclude = {
  branch: { select: { id: true, name: true } },
  ingredient: { select: { id: true, name: true } },
} satisfies Prisma.InventoryRequestInclude;

/**
 * Inventory requests repository. All Prisma calls for this module live here —
 * the router and service layers never call Prisma directly.
 */
export const inventoryRequestsRepository = {
  /** Undefined branchIds means no branch filter — used for super_admin, whose JWT carries no branch_ids. */
  findPending(branchIds?: string[]) {
    return prisma.inventoryRequest.findMany({
      where: {
        status: 'pending',
        ...(branchIds !== undefined && { branchId: { in: branchIds } }),
      },
      include: detailInclude,
      orderBy: { createdAt: 'asc' },
    });
  },

  findByBranch(branchId: string) {
    return prisma.inventoryRequest.findMany({
      where: { branchId },
      include: detailInclude,
      orderBy: { createdAt: 'desc' },
    });
  },

  findById(id: string) {
    return prisma.inventoryRequest.findUnique({ where: { id }, include: detailInclude });
  },

  create(data: CreateInventoryRequestData) {
    return prisma.inventoryRequest.create({
      data: {
        branchId: data.branchId,
        ingredientId: data.ingredientId,
        type: data.type,
        quantity: data.quantity,
        reason: data.reason,
        requestedById: data.requestedById,
        requestedByName: data.requestedByName,
      },
      include: detailInclude,
    });
  },

  /**
   * Approves a pending request atomically — the request's status flip and
   * its stock effect commit together or not at all. Mirrors
   * inventory.repository.ts's appendMovement: Ingredient.currentStock is
   * never written directly, only ever derived from summing
   * InventoryMovement.quantityChange, so the ingredient's quantity is
   * "updated" by inserting the movement row in the same transaction as the
   * status update, not by touching the Ingredient row itself.
   */
  approve(id: string, data: ApproveInventoryRequestData) {
    return prisma.$transaction(async (tx) => {
      const sumResult = await tx.inventoryMovement.aggregate({
        where: { ingredientId: data.ingredientId },
        _sum: { quantityChange: true },
      });
      const quantityBefore = sumResult._sum.quantityChange ?? new Prisma.Decimal(0);
      const signedQuantity = data.type === 'stock_out' ? data.quantity.negated() : data.quantity;
      const quantityAfter = quantityBefore.plus(signedQuantity);

      const movement = await tx.inventoryMovement.create({
        data: {
          branchId: data.branchId,
          ingredientId: data.ingredientId,
          // No dedicated "stock_out" MovementType exists — a negative
          // manual_adjustment is the same shape adjustIngredient already
          // uses for a signed, non-waste, non-transfer stock decrease.
          movementType: data.type === 'stock_out' ? MOVEMENT_TYPE.MANUAL_ADJUSTMENT : MOVEMENT_TYPE.STOCK_IN,
          quantityChange: signedQuantity,
          quantityBefore,
          quantityAfter,
          referenceId: id,
          notes: `Inventory request approved: ${data.reason}`,
          approvedBy: data.approvedById,
          recordedBy: data.requestedById,
        },
      });

      const updated = await tx.inventoryRequest.update({
        where: { id },
        data: {
          status: 'approved',
          approvedById: data.approvedById,
          approvedByName: data.approvedByName,
          approvedAt: new Date(),
        },
        include: detailInclude,
      });

      return { request: updated, movement };
    });
  },

  reject(id: string, data: RejectInventoryRequestData) {
    return prisma.inventoryRequest.update({
      where: { id },
      data: {
        status: 'rejected',
        approvedById: data.approvedById,
        approvedByName: data.approvedByName,
        rejectionReason: data.rejectionReason,
        approvedAt: new Date(),
      },
      include: detailInclude,
    });
  },
};
