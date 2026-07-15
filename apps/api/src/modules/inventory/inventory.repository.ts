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
export interface CascadeAffectedFlavor {
  flavorId: string;
  flavorName: string;
}

export interface CascadeAffectedProduct {
  productId: string;
  productName: string;
}

export interface OutOfStockCascadeResult {
  affectedFlavors: CascadeAffectedFlavor[];
  affectedProducts: CascadeAffectedProduct[];
}

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

  /**
   * Architecture doc §7.2 Out-of-Stock Cascade. Runs only when an
   * ingredient's stock has reached zero (caller's responsibility to check).
   * flavor_id IS NULL recipe/override rows are base ingredients (§7.1) —
   * they apply to every flavor of that variant, not to a literal "null
   * flavor" (branch_flavor_availability has no such row), so they're
   * expanded to every flavor linked to the variant via product_variant_flavors
   * before being cascaded. Idempotent: a flavor/product already marked
   * unavailable is skipped, both to avoid redundant writes and so the
   * caller's "affected" result — and therefore the socket broadcast — never
   * repeats something already broadcast by an earlier deduction. Runs
   * entirely inside one transaction: either the whole cascade commits, or
   * none of it does.
   */
  async runOutOfStockCascade(branchId: string, ingredientId: string): Promise<OutOfStockCascadeResult> {
    return prisma.$transaction(async (tx) => {
      const [masterRows, overrideRows] = await Promise.all([
        tx.recipe.findMany({ where: { ingredientId, deletedAt: null }, select: { productVariantId: true, flavorId: true } }),
        tx.branchRecipeOverride.findMany({
          where: { ingredientId, branchId, deletedAt: null },
          select: { productVariantId: true, flavorId: true },
        }),
      ]);
      const rows = [...masterRows, ...overrideRows];
      if (rows.length === 0) return { affectedFlavors: [], affectedProducts: [] };

      const baseVariantIds = [...new Set(rows.filter((r) => r.flavorId === null).map((r) => r.productVariantId))];
      const directFlavorIds = new Set(rows.filter((r) => r.flavorId !== null).map((r) => r.flavorId as string));

      if (baseVariantIds.length > 0) {
        const expanded = await tx.productVariantFlavor.findMany({
          where: { productVariantId: { in: baseVariantIds } },
          select: { flavorId: true },
        });
        for (const row of expanded) directFlavorIds.add(row.flavorId);
      }

      if (directFlavorIds.size === 0) return { affectedFlavors: [], affectedProducts: [] };

      const existingAvailability = await tx.branchFlavorAvailability.findMany({
        where: { branchId, flavorId: { in: [...directFlavorIds] } },
        select: { flavorId: true, isAvailable: true },
      });
      const alreadyUnavailable = new Set(existingAvailability.filter((r) => !r.isAvailable).map((r) => r.flavorId));
      const flavorIdsToDisable = [...directFlavorIds].filter((id) => !alreadyUnavailable.has(id));

      if (flavorIdsToDisable.length === 0) return { affectedFlavors: [], affectedProducts: [] };

      const flavors = await tx.flavor.findMany({ where: { id: { in: flavorIdsToDisable } }, select: { id: true, name: true } });

      for (const flavorId of flavorIdsToDisable) {
        await tx.branchFlavorAvailability.upsert({
          where: { branchId_flavorId: { branchId, flavorId } },
          create: { branchId, flavorId, isAvailable: false, unavailableReason: 'out_of_stock' },
          update: { isAvailable: false, unavailableReason: 'out_of_stock' },
        });
      }

      const linkedVariantFlavors = await tx.productVariantFlavor.findMany({
        where: { flavorId: { in: flavorIdsToDisable } },
        select: { productVariant: { select: { productId: true } } },
      });
      const candidateProductIds = [...new Set(linkedVariantFlavors.map((r) => r.productVariant.productId))];

      const affectedProducts: CascadeAffectedProduct[] = [];
      for (const productId of candidateProductIds) {
        const productFlavorLinks = await tx.productVariantFlavor.findMany({
          where: { productVariant: { productId } },
          select: { flavorId: true },
        });
        const distinctFlavorIds = [...new Set(productFlavorLinks.map((r) => r.flavorId))];

        const unavailableForProduct = await tx.branchFlavorAvailability.findMany({
          where: { branchId, flavorId: { in: distinctFlavorIds }, isAvailable: false },
          select: { flavorId: true },
        });
        const unavailableSet = new Set(unavailableForProduct.map((r) => r.flavorId));
        const anyFlavorStillAvailable = distinctFlavorIds.some((id) => !unavailableSet.has(id));
        if (anyFlavorStillAvailable) continue;

        const existingProductAvailability = await tx.branchProductAvailability.findUnique({
          where: { branchId_productId: { branchId, productId } },
        });
        if (existingProductAvailability?.isAvailable === false) continue;

        await tx.branchProductAvailability.upsert({
          where: { branchId_productId: { branchId, productId } },
          create: { branchId, productId, isAvailable: false },
          update: { isAvailable: false },
        });

        const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true, name: true } });
        if (product) affectedProducts.push({ productId: product.id, productName: product.name });
      }

      return {
        affectedFlavors: flavors.map((f) => ({ flavorId: f.id, flavorName: f.name })),
        affectedProducts,
      };
    });
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
