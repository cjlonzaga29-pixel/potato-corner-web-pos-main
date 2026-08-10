import { Prisma, type IngredientCategory } from '@prisma/client';
import type { InventoryDeductionStatus, MovementType } from '@potato-corner/shared';
import { config } from '../../config/index.js';
import { prisma } from '../../lib/prisma.js';
import { hashToLockId } from '../../lib/pg-lock.js';
import { sha256Hex } from '../../lib/hash.js';
import { productInventoryRepository } from '../product-inventory/product-inventory.repository.js';
import { IngredientError } from './inventory.types.js';
import type { AppendMovementInput, CreateIngredientData, MovementListFilters, UpdateIngredientData } from './inventory.types.js';

const movementInclude = {
  ingredient: { select: { name: true } },
} satisfies Prisma.InventoryMovementInclude;

/**
 * CR-010A.1 — creates the projection outbox row for a just-created movement,
 * inside the same transaction client that created it. A no-op while the
 * feature flag is off, so existing movement-write behavior is unchanged.
 * Called from every movement-creating path (appendMovement and
 * transferStock's two legs) so no producer needs its own outbox logic.
 */
async function createProjectionOutboxRow(movementId: string, client: Prisma.TransactionClient): Promise<void> {
  if (!config.inventoryProjectionOutboxEnabled) return;
  await client.inventoryProjectionOutbox.create({ data: { movementId } });
}

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

/**
 * Acquires the same per-ingredient advisory lock
 * transactions.service.ts's reverseInventoryForTransaction already takes
 * for legacy-snapshot void/refund reversals (hashToLockId(sha256Hex(ingredientId)))
 * before reading the current ledger sum, then lets the caller validate or
 * compute the movement's quantityChange against that value — `resolve`
 * returns either the quantityChange to record or null to skip (e.g. a
 * physical count with zero variance). Without this lock, stockIn/adjust/
 * waste/physicalCount previously read the ledger sum and wrote a new
 * movement as two unguarded steps: two concurrent calls against the same
 * ingredient (e.g. two wastes, or an adjustment racing a waste) could both
 * read the same "before" stock, both pass an insufficient-stock check that
 * should only have let one of them through, and both write — driving stock
 * negative despite the explicit guards, and leaving the quantityBefore/
 * quantityAfter ledger snapshots inconsistent with the true running total.
 */
async function appendMovementLocked(
  input: Omit<AppendMovementInput, 'quantityChange'>,
  resolve: (currentStock: Prisma.Decimal) => number | null,
  tx?: Prisma.TransactionClient,
) {
  const run = async (client: Prisma.TransactionClient) => {
    const lockId = hashToLockId(sha256Hex(input.ingredientId));
    await client.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;

    const sumResult = await client.inventoryMovement.aggregate({
      where: { ingredientId: input.ingredientId },
      _sum: { quantityChange: true },
    });
    const quantityBefore = sumResult._sum.quantityChange ?? new Prisma.Decimal(0);

    const quantityChange = resolve(quantityBefore);
    if (quantityChange === null) return null;

    const quantityAfter = quantityBefore.plus(quantityChange);

    const movement = await client.inventoryMovement.create({
      data: {
        branchId: input.branchId,
        ingredientId: input.ingredientId,
        movementType: input.movementType,
        quantityChange,
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
    await createProjectionOutboxRow(movement.id, client);
    return movement;
  };
  if (tx) return run(tx);
  return prisma.$transaction(run);
}

export const inventoryRepository = {
  findAllIngredients(branchId?: string) {
    return prisma.ingredient.findMany({
      where: { deletedAt: null, ...(branchId && { branchId }) },
      orderBy: { name: 'asc' },
    });
  },

  findIngredientById(id: string, tx?: Prisma.TransactionClient) {
    return (tx ?? prisma).ingredient.findFirst({ where: { id, deletedAt: null } });
  },

  /** Includes soft-deleted ingredients too — used for transfer/audit lookups where a deleted row still needs to resolve by ID. */
  findIngredientByIdIncludingDeleted(id: string) {
    return prisma.ingredient.findUnique({ where: { id } });
  },

  findIngredientByBranchAndName(branchId: string, name: string) {
    return prisma.ingredient.findFirst({ where: { branchId, name, deletedAt: null } });
  },

  /**
   * CR-004 idempotent branch provisioning. Creates a zero-stock Ingredient
   * row for a (name, unit) identity at a branch only if one doesn't already
   * exist there (matched the same way findIngredientByBranchAndName does —
   * exact name match, active rows only). Safe to call repeatedly for the
   * same branch/identity without creating duplicates, so callers don't need
   * to pre-check existence themselves.
   */
  async provisionIngredient(
    branchId: string,
    name: string,
    unit: string,
    category?: IngredientCategory,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? prisma;
    const existing = await client.ingredient.findFirst({ where: { branchId, name, deletedAt: null } });
    if (existing) return existing;
    return client.ingredient.create({
      data: {
        branchId,
        name,
        unit,
        currentStock: 0,
        lowStockThreshold: 0,
        criticalThreshold: 0,
        ...(category && { category }),
      },
    });
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
  async getCurrentStock(ingredientId: string, tx?: Prisma.TransactionClient): Promise<Prisma.Decimal> {
    const result = await (tx ?? prisma).inventoryMovement.aggregate({
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
   * from at write time. quantityChange is fixed (stock-in, transfer legs) —
   * see appendMovementLocked for callers that need to validate or compute
   * quantityChange against a value nothing else can change out from under
   * them.
   */
  async appendMovement(input: AppendMovementInput, tx?: Prisma.TransactionClient) {
    const movement = await appendMovementLocked(input, () => input.quantityChange, tx);
    // resolve is `() => input.quantityChange`, a fixed number — it never
    // returns null, so this call never actually skips the write. Only
    // appendMovementLocked's other caller (physical count, whose resolve can
    // skip a zero-variance write) can hit that case.
    if (!movement) throw new Error('unreachable: appendMovement resolve never returns null');
    return movement;
  },

  appendMovementLocked,

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
      // Sorted lock order (by ingredient ID) — matches the anti-deadlock
      // pattern transactions.service.ts's sale deduction and
      // universal-inventory.service.ts's transferStock already use: two
      // transfers touching an overlapping ingredient pair must always
      // acquire their locks in the same order, or Postgres can deadlock them
      // against each other instead of one simply waiting for the other.
      const lockIngredientIds = [params.fromIngredientId, params.toIngredientId].sort();
      for (const ingredientId of lockIngredientIds) {
        const lockId = hashToLockId(sha256Hex(ingredientId));
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
      }

      const outSum = await tx.inventoryMovement.aggregate({
        where: { ingredientId: params.fromIngredientId },
        _sum: { quantityChange: true },
      });
      const outBefore = outSum._sum.quantityChange ?? new Prisma.Decimal(0);
      // Authoritative recheck under lock — the service layer's pre-check
      // (inventoryService.transferStock) reads current stock before this
      // transaction and can go stale under a concurrent writer; this is the
      // check that actually prevents the source from going negative.
      if (outBefore.toNumber() - params.quantity < 0) {
        throw new IngredientError('INSUFFICIENT_STOCK', 'Transfer quantity exceeds current stock at the source branch', 409);
      }
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
      await createProjectionOutboxRow(transferOut.id, tx);

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
      await createProjectionOutboxRow(transferIn.id, tx);

      return { transferOut, transferIn };
    });
  },

  /**
   * There is no transactions module yet (Phase 6+ is still unimplemented),
   * so this lives here rather than in a repository that doesn't exist —
   * it's the one write the Phase 8 deduction worker needs against the
   * Transaction row that already carries this status field in the schema.
   */
  updateTransactionDeductionStatus(transactionId: string, status: InventoryDeductionStatus, tx?: Prisma.TransactionClient) {
    return (tx ?? prisma).transaction.update({ where: { id: transactionId }, data: { inventoryDeductionStatus: status } });
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
  async runOutOfStockCascade(branchId: string, ingredientId: string, tx?: Prisma.TransactionClient): Promise<OutOfStockCascadeResult> {
    const run = async (client: Prisma.TransactionClient) => {
      const rows = await productInventoryRepository.findByIngredientId(ingredientId, client);
      if (rows.length === 0) return { affectedFlavors: [], affectedProducts: [] };

      const baseVariantIds = [...new Set(rows.filter((r) => r.flavorId === null).map((r) => r.productVariantId))];
      const directFlavorIds = new Set(rows.filter((r) => r.flavorId !== null).map((r) => r.flavorId as string));

      if (baseVariantIds.length > 0) {
        const expanded = await client.productVariantFlavor.findMany({
          where: { productVariantId: { in: baseVariantIds } },
          select: { flavorId: true },
        });
        for (const row of expanded) directFlavorIds.add(row.flavorId);
      }

      if (directFlavorIds.size === 0) return { affectedFlavors: [], affectedProducts: [] };

      const existingAvailability = await client.branchFlavorAvailability.findMany({
        where: { branchId, flavorId: { in: [...directFlavorIds] } },
        select: { flavorId: true, isAvailable: true },
      });
      const alreadyUnavailable = new Set(existingAvailability.filter((r) => !r.isAvailable).map((r) => r.flavorId));
      const flavorIdsToDisable = [...directFlavorIds].filter((id) => !alreadyUnavailable.has(id));

      if (flavorIdsToDisable.length === 0) return { affectedFlavors: [], affectedProducts: [] };

      const flavors = await client.flavor.findMany({ where: { id: { in: flavorIdsToDisable } }, select: { id: true, name: true } });

      for (const flavorId of flavorIdsToDisable) {
        await client.branchFlavorAvailability.upsert({
          where: { branchId_flavorId: { branchId, flavorId } },
          create: { branchId, flavorId, isAvailable: false, unavailableReason: 'out_of_stock' },
          update: { isAvailable: false, unavailableReason: 'out_of_stock' },
        });
      }

      const linkedVariantFlavors = await client.productVariantFlavor.findMany({
        where: { flavorId: { in: flavorIdsToDisable } },
        select: { productVariant: { select: { productId: true } } },
      });
      const candidateProductIds = [...new Set(linkedVariantFlavors.map((r) => r.productVariant.productId))];

      const affectedProducts: CascadeAffectedProduct[] = [];
      for (const productId of candidateProductIds) {
        const productFlavorLinks = await client.productVariantFlavor.findMany({
          where: { productVariant: { productId } },
          select: { flavorId: true },
        });
        const distinctFlavorIds = [...new Set(productFlavorLinks.map((r) => r.flavorId))];

        const unavailableForProduct = await client.branchFlavorAvailability.findMany({
          where: { branchId, flavorId: { in: distinctFlavorIds }, isAvailable: false },
          select: { flavorId: true },
        });
        const unavailableSet = new Set(unavailableForProduct.map((r) => r.flavorId));
        const anyFlavorStillAvailable = distinctFlavorIds.some((id) => !unavailableSet.has(id));
        if (anyFlavorStillAvailable) continue;

        const existingProductAvailability = await client.branchProductAvailability.findUnique({
          where: { branchId_productId: { branchId, productId } },
        });
        if (existingProductAvailability?.isAvailable === false) continue;

        await client.branchProductAvailability.upsert({
          where: { branchId_productId: { branchId, productId } },
          create: { branchId, productId, isAvailable: false },
          update: { isAvailable: false },
        });

        const product = await client.product.findUnique({ where: { id: productId }, select: { id: true, name: true } });
        if (product) affectedProducts.push({ productId: product.id, productName: product.name });
      }

      return {
        affectedFlavors: flavors.map((f) => ({ flavorId: f.id, flavorName: f.name })),
        affectedProducts,
      };
    };
    if (tx) return run(tx);
    return prisma.$transaction(run);
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
