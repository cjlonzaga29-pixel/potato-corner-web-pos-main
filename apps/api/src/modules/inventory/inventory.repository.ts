import { Prisma } from '@prisma/client';
import type { InventoryDeductionStatus, MovementType } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import type { AppendMovementInput, CreateIngredientData, MovementListFilters, UpdateIngredientData } from './inventory.types.js';

const movementInclude = {
  ingredient: { select: { name: true } },
} satisfies Prisma.InventoryMovementInclude;

/**
 * Inventory repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 *
 * Current stock is never stored or mutated directly on Ingredient — it is
 * always derived by summing InventoryMovement.quantityChange for the
 * ingredient (append-only ledger, replayable per the schema's own doc
 * comment). Every write path funnels through appendMovement.
 */
export const inventoryRepository = {
  findAllIngredients(branchId?: string) {
    return prisma.ingredient.findMany({
      where: { deletedAt: null, ...(branchId && { branchId }) },
      orderBy: { name: 'asc' },
    });
  },

  findIngredientById(id: string) {
    return prisma.ingredient.findFirst({ where: { id, deletedAt: null } });
  },

  /** Includes soft-deleted ingredients too — used for transfer/audit lookups where a deleted row still needs to resolve by ID. */
  findIngredientByIdIncludingDeleted(id: string) {
    return prisma.ingredient.findUnique({ where: { id } });
  },

  findIngredientByBranchAndName(branchId: string, name: string) {
    return prisma.ingredient.findFirst({ where: { branchId, name, deletedAt: null } });
  },

  createIngredient(data: CreateIngredientData) {
    return prisma.ingredient.create({
      data: {
        branchId: data.branchId,
        name: data.name,
        unit: data.unit,
        currentStock: data.currentStock,
        lowStockThreshold: data.lowStockThreshold,
        criticalThreshold: data.criticalThreshold,
        unitCost: data.unitCost,
      },
    });
  },

  updateIngredient(id: string, data: UpdateIngredientData) {
    return prisma.ingredient.update({
      where: { id },
      data: {
        name: data.name,
        unit: data.unit,
        lowStockThreshold: data.lowStockThreshold,
        criticalThreshold: data.criticalThreshold,
        unitCost: data.unitCost,
      },
    });
  },

  softDeleteIngredient(id: string) {
    return prisma.ingredient.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  /** Derived current stock for one ingredient — sum of every movement ever recorded against it. */
  async getCurrentStock(ingredientId: string): Promise<Prisma.Decimal> {
    const result = await prisma.inventoryMovement.aggregate({
      where: { ingredientId },
      _sum: { quantityChange: true },
    });
    return result._sum.quantityChange ?? new Prisma.Decimal(0);
  },

  /** Batched version of getCurrentStock — one query instead of N for a branch inventory list. */
  async getCurrentStockMap(ingredientIds: string[]): Promise<Map<string, Prisma.Decimal>> {
    if (ingredientIds.length === 0) return new Map();
    const rows = await prisma.inventoryMovement.groupBy({
      by: ['ingredientId'],
      where: { ingredientId: { in: ingredientIds } },
      _sum: { quantityChange: true },
    });
    const map = new Map<string, Prisma.Decimal>();
    for (const row of rows) {
      map.set(row.ingredientId, row._sum.quantityChange ?? new Prisma.Decimal(0));
    }
    return map;
  },

  /**
   * The single write path for every stock-affecting operation (stock-in,
   * adjustment, waste, physical count, transfer, and Phase 8's sale
   * deduction worker). Computes quantityBefore/quantityAfter from the
   * current ledger sum inside the same transaction as the insert, so the
   * snapshot on the row is always consistent with the sum it was derived
   * from at write time.
   */
  async appendMovement(input: AppendMovementInput) {
    return prisma.$transaction(async (tx) => {
      const sumResult = await tx.inventoryMovement.aggregate({
        where: { ingredientId: input.ingredientId },
        _sum: { quantityChange: true },
      });
      const quantityBefore = sumResult._sum.quantityChange ?? new Prisma.Decimal(0);
      const quantityAfter = quantityBefore.plus(input.quantityChange);

      return tx.inventoryMovement.create({
        data: {
          branchId: input.branchId,
          ingredientId: input.ingredientId,
          movementType: input.movementType,
          quantityChange: input.quantityChange,
          quantityBefore,
          quantityAfter,
          referenceId: input.referenceId,
          notes: input.notes,
          imageProofUrl: input.imageProofUrl,
          imageProofType: input.imageProofType,
          approvedBy: input.approvedBy,
          recordedBy: input.recordedBy,
        },
        include: movementInclude,
      });
    });
  },

  /**
   * Both legs of a branch-to-branch transfer in one transaction — either
   * both movements are recorded or neither is.
   */
  async transferStock(params: {
    fromBranchId: string;
    fromIngredientId: string;
    toBranchId: string;
    toIngredientId: string;
    quantity: number;
    notes?: string;
    recordedBy: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const outSum = await tx.inventoryMovement.aggregate({
        where: { ingredientId: params.fromIngredientId },
        _sum: { quantityChange: true },
      });
      const outBefore = outSum._sum.quantityChange ?? new Prisma.Decimal(0);
      const outAfter = outBefore.minus(params.quantity);

      const transferOut = await tx.inventoryMovement.create({
        data: {
          branchId: params.fromBranchId,
          ingredientId: params.fromIngredientId,
          movementType: 'transfer_out',
          quantityChange: new Prisma.Decimal(params.quantity).negated(),
          quantityBefore: outBefore,
          quantityAfter: outAfter,
          referenceId: params.toIngredientId,
          notes: params.notes,
          recordedBy: params.recordedBy,
        },
        include: movementInclude,
      });

      const inSum = await tx.inventoryMovement.aggregate({
        where: { ingredientId: params.toIngredientId },
        _sum: { quantityChange: true },
      });
      const inBefore = inSum._sum.quantityChange ?? new Prisma.Decimal(0);
      const inAfter = inBefore.plus(params.quantity);

      const transferIn = await tx.inventoryMovement.create({
        data: {
          branchId: params.toBranchId,
          ingredientId: params.toIngredientId,
          movementType: 'transfer_in',
          quantityChange: params.quantity,
          quantityBefore: inBefore,
          quantityAfter: inAfter,
          referenceId: params.fromIngredientId,
          notes: params.notes,
          recordedBy: params.recordedBy,
        },
        include: movementInclude,
      });

      return { transferOut, transferIn };
    });
  },

  /**
   * There is no transactions module yet (Phase 6+ is still unimplemented),
   * so this lives here rather than in a repository that doesn't exist —
   * it's the one write the Phase 8 deduction worker needs against the
   * Transaction row that already carries this status field in the schema.
   */
  updateTransactionDeductionStatus(transactionId: string, status: InventoryDeductionStatus) {
    return prisma.transaction.update({ where: { id: transactionId }, data: { inventoryDeductionStatus: status } });
  },

  /**
   * Used by the Phase 8 deduction worker to make a retried job idempotent
   * per-ingredient: a job that fails partway through (having already
   * appended movements for some ingredients) must not re-append those on
   * retry, but still needs to process whatever it didn't reach.
   */
  async hasMovementForReference(ingredientId: string, referenceId: string, movementType: MovementType): Promise<boolean> {
    const existing = await prisma.inventoryMovement.findFirst({
      where: { ingredientId, referenceId, movementType },
      select: { id: true },
    });
    return existing !== null;
  },

  async findMovements(branchId: string, filters: MovementListFilters) {
    const where: Prisma.InventoryMovementWhereInput = {
      branchId,
      ...(filters.ingredientId && { ingredientId: filters.ingredientId }),
      ...(filters.movementType && { movementType: filters.movementType }),
      ...((filters.fromDate ?? filters.toDate) && {
        createdAt: {
          ...(filters.fromDate && { gte: filters.fromDate }),
          ...(filters.toDate && { lte: filters.toDate }),
        },
      }),
    };

    const [movements, total] = await Promise.all([
      prisma.inventoryMovement.findMany({
        where,
        include: movementInclude,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.inventoryMovement.count({ where }),
    ]);

    return { movements, total };
  },
};
