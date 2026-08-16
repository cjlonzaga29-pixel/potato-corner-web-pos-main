import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { inventoryStockLockId } from '../../lib/pg-lock.js';
import type {
  CreateInventoryCategoryData,
  UpdateInventoryCategoryData,
  CreateUnitOfMeasureData,
  UpdateUnitOfMeasureData,
  CreateUnitConversionData,
  CreateInventoryItemUnitConversionData,
  UpdateInventoryItemUnitConversionData,
  CreateInventoryItemData,
  UpdateInventoryItemData,
  InventoryStockMovementType,
  InventoryProofType,
  CreateInventoryCostCorrectionData,
} from './universal-inventory.types.js';

const inventoryItemInclude = {
  category: { select: { id: true, name: true } },
  baseUnit: { select: { id: true, code: true, name: true } },
} as const;

const stockMovementInclude = {
  inventoryItem: { select: { name: true } },
  unit: { select: { code: true } },
  enteredUnit: { select: { code: true } },
} satisfies Prisma.InventoryStockMovementInclude;

const costCorrectionInclude = {
  branch: { select: { name: true } },
  inventoryItem: { select: { name: true } },
} satisfies Prisma.InventoryCostCorrectionInclude;

const itemConversionInclude = {
  fromUnit: { select: { id: true, code: true, name: true } },
  toUnit: { select: { id: true, code: true, name: true } },
} satisfies Prisma.InventoryItemUnitConversionInclude;

export interface CreateStockMovementInput {
  branchId: string;
  inventoryItemId: string;
  movementType: InventoryStockMovementType;
  quantityChange: Prisma.Decimal | number;
  quantityBefore: Prisma.Decimal | number;
  quantityAfter: Prisma.Decimal | number;
  unitId?: string;
  referenceType?: string;
  referenceId?: string;
  notes?: string;
  performedByUserId?: string;
  /** Carrying cost snapshot at movement time — see schema.prisma's InventoryStockMovement doc comment. */
  unitCost?: Prisma.Decimal;
  totalCost?: Prisma.Decimal;
  /** WASTE only: accountable staff member, distinct from performedByUserId. */
  responsibleUserId?: string;
  /** RECEIVING/WASTE only: purchase-unit quantity/unit as entered, distinct from quantityChange/unitId (always base-unit). See schema.prisma's InventoryStockMovement doc comment. */
  enteredQuantity?: Prisma.Decimal | number;
  enteredUnitId?: string;
  proofKey?: string;
  proofType?: InventoryProofType;
}

/**
 * All Prisma calls for the CR-010 Universal Inventory identity layer
 * (InventoryCategory, UnitOfMeasure, UnitConversion, InventoryItem, and
 * branch assignment via InventoryStock) live here — router/service never
 * call Prisma directly.
 */
export const universalInventoryRepository = {
  // --- Categories ---
  listCategories(includeInactive: boolean) {
    return prisma.inventoryCategory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
    });
  },
  findCategoryById(id: string) {
    return prisma.inventoryCategory.findUnique({ where: { id } });
  },
  findCategoryByName(name: string) {
    return prisma.inventoryCategory.findFirst({ where: { name } });
  },
  createCategory(data: CreateInventoryCategoryData) {
    return prisma.inventoryCategory.create({ data });
  },
  updateCategory(id: string, data: UpdateInventoryCategoryData) {
    return prisma.inventoryCategory.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.code !== undefined && { code: data.code }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });
  },

  // --- Units of measure ---
  listUnits(includeInactive: boolean) {
    return prisma.unitOfMeasure.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { code: 'asc' },
    });
  },
  findUnitById(id: string) {
    return prisma.unitOfMeasure.findUnique({ where: { id } });
  },
  findUnitByCode(code: string) {
    return prisma.unitOfMeasure.findUnique({ where: { code } });
  },
  createUnit(data: CreateUnitOfMeasureData) {
    return prisma.unitOfMeasure.create({
      data: {
        code: data.code,
        name: data.name,
        dimension: data.dimension,
        isBaseUnit: data.isBaseUnit ?? false,
      },
    });
  },
  updateUnit(id: string, data: UpdateUnitOfMeasureData) {
    return prisma.unitOfMeasure.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });
  },

  // --- Unit conversions ---
  listConversions() {
    return prisma.unitConversion.findMany({
      include: {
        fromUnit: { select: { id: true, code: true } },
        toUnit: { select: { id: true, code: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  },
  findConversion(fromUnitId: string, toUnitId: string) {
    return prisma.unitConversion.findUnique({ where: { fromUnitId_toUnitId: { fromUnitId, toUnitId } } });
  },
  createConversion(data: CreateUnitConversionData) {
    return prisma.unitConversion.create({
      data: { fromUnitId: data.fromUnitId, toUnitId: data.toUnitId, factor: data.factor },
    });
  },

  // --- Item-specific unit conversions (TASK 115, enriched TASK 121) ---
  listItemConversions(inventoryItemId: string) {
    return prisma.inventoryItemUnitConversion.findMany({
      where: { inventoryItemId },
      include: itemConversionInclude,
      orderBy: { createdAt: 'asc' },
    });
  },
  findItemConversionById(id: string) {
    return prisma.inventoryItemUnitConversion.findUnique({ where: { id }, include: itemConversionInclude });
  },
  findItemConversion(inventoryItemId: string, fromUnitId: string, toUnitId: string) {
    return prisma.inventoryItemUnitConversion.findUnique({
      where: { inventoryItemId_fromUnitId_toUnitId: { inventoryItemId, fromUnitId, toUnitId } },
    });
  },
  createItemConversion(data: CreateInventoryItemUnitConversionData) {
    return prisma.inventoryItemUnitConversion.create({
      data: { inventoryItemId: data.inventoryItemId, fromUnitId: data.fromUnitId, toUnitId: data.toUnitId, factor: data.factor },
      include: itemConversionInclude,
    });
  },
  updateItemConversion(id: string, data: UpdateInventoryItemUnitConversionData) {
    return prisma.inventoryItemUnitConversion.update({ where: { id }, data: { factor: data.factor }, include: itemConversionInclude });
  },
  deleteItemConversion(id: string) {
    return prisma.inventoryItemUnitConversion.delete({ where: { id } });
  },

  // --- Inventory items (the universal identity) ---
  listItems(includeInactive: boolean) {
    return prisma.inventoryItem.findMany({
      where: includeInactive ? {} : { deletedAt: null },
      include: inventoryItemInclude,
      orderBy: { name: 'asc' },
    });
  },
  findItemById(id: string) {
    return prisma.inventoryItem.findFirst({ where: { id, deletedAt: null }, include: inventoryItemInclude });
  },
  findItemByName(name: string) {
    return prisma.inventoryItem.findFirst({ where: { name, deletedAt: null } });
  },
  findItemBySku(sku: string) {
    return prisma.inventoryItem.findFirst({ where: { sku, deletedAt: null } });
  },
  findItemByBarcode(barcode: string) {
    return prisma.inventoryItem.findFirst({ where: { barcode, deletedAt: null } });
  },
  createItem(data: CreateInventoryItemData) {
    return prisma.inventoryItem.create({
      data: {
        name: data.name,
        sku: data.sku,
        barcode: data.barcode,
        categoryId: data.categoryId,
        baseUnitId: data.baseUnitId,
        trackInventory: data.trackInventory ?? true,
      },
      include: inventoryItemInclude,
    });
  },
  updateItem(id: string, data: UpdateInventoryItemData) {
    return prisma.inventoryItem.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.sku !== undefined && { sku: data.sku }),
        ...(data.barcode !== undefined && { barcode: data.barcode }),
        ...(data.categoryId !== undefined && { categoryId: data.categoryId }),
        ...(data.trackInventory !== undefined && { trackInventory: data.trackInventory }),
      },
      include: inventoryItemInclude,
    });
  },

  // --- Branch assignment (R2 — creates a zero-stock InventoryStock row) ---
  listAssignedBranches(inventoryItemId: string) {
    return prisma.inventoryStock.findMany({
      where: { inventoryItemId },
      include: { branch: { select: { id: true, code: true, name: true, city: true } } },
    });
  },
  findAssignment(branchId: string, inventoryItemId: string) {
    return prisma.inventoryStock.findUnique({ where: { branchId_inventoryItemId: { branchId, inventoryItemId } } });
  },
  /**
   * CR-007 §14.1 — provisioning a branch with a new item creates zero
   * InventoryStock rows worth of movement history: a plain create at
   * quantityOnHand's default (0), no InventoryMovement posted.
   */
  assignToBranch(branchId: string, inventoryItemId: string) {
    return prisma.inventoryStock.create({ data: { branchId, inventoryItemId } });
  },

  /** Symmetric fan-out helpers (CR-007 §20 item 9) — every active, tracked InventoryItem gets a zero-stock InventoryStock row in every branch. */
  listActiveTrackedItemIds(tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.inventoryItem.findMany({
      where: { deletedAt: null, trackInventory: true },
      select: { id: true },
    });
  },
  createStockRows(rows: { branchId: string; inventoryItemId: string }[], tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.inventoryStock.createMany({ data: rows, skipDuplicates: true });
  },

  /** Dry-run support for the branch-inventory-cutover backfill script — how many of the expected (branch, item) rows already exist. */
  countExistingStockRows(branchIds: string[], inventoryItemIds: string[]) {
    if (branchIds.length === 0 || inventoryItemIds.length === 0) return Promise.resolve(0);
    return prisma.inventoryStock.count({
      where: { branchId: { in: branchIds }, inventoryItemId: { in: inventoryItemIds } },
    });
  },

  /** Waste accountability: the write must only accept an active user actually assigned to this branch (frontend picker sources the same-branch list from GET /api/employees?branch_id=). */
  async isActiveUserInBranch(userId: string, branchId: string): Promise<boolean> {
    const assignment = await prisma.userBranchAssignment.findFirst({
      where: { userId, branchId, removedAt: null, user: { isActive: true } },
      select: { id: true },
    });
    return assignment !== null;
  },

  // --- Branch inventory cutover: direct InventoryStock read/write ---

  /**
   * Takes a per-(branch, item) advisory lock and returns the current
   * InventoryStock row, inside the given transaction. Must be called before
   * any read-then-write of quantityOnHand so concurrent operations against
   * the same branch/item serialize instead of racing (same idiom as
   * transactions.service.ts's deductInventoryForSale).
   */
  async lockAndGetStock(branchId: string, inventoryItemId: string, tx: Prisma.TransactionClient) {
    const lockId = inventoryStockLockId(branchId, inventoryItemId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
    return tx.inventoryStock.findUnique({ where: { branchId_inventoryItemId: { branchId, inventoryItemId } } });
  },

  /**
   * Absolute set — used only where the caller's new value is itself the
   * authoritative truth being recorded, not a computed offset from the old
   * one. Today that's exactly one case: submitPhysicalCount, where
   * countedQuantity *is* the new on-hand quantity by definition. Every
   * delta-based writer (receive/adjust/waste/transfer) uses
   * incrementStockQuantity below instead.
   */
  updateStockQuantity(branchId: string, inventoryItemId: string, quantityOnHand: Prisma.Decimal, tx: Prisma.TransactionClient) {
    return tx.inventoryStock.update({
      where: { branchId_inventoryItemId: { branchId, inventoryItemId } },
      data: { quantityOnHand, version: { increment: 1 } },
    });
  },

  /**
   * Atomic relative write — `quantityOnHand: { increment: delta }` at the
   * database layer, rather than a locally-computed absolute SET, for the
   * naturally delta-based manual inventory operations (receive/adjust/
   * waste/transfer). `delta` may be negative — Prisma's `increment` accepts
   * a signed value, so this single method covers both directions (waste and
   * transfer-out pass a negated delta). Still called only after
   * lockAndGetStock's advisory lock like updateStockQuantity above, but the
   * DB-level increment is a second, independent guarantee against a lost
   * update even if the lock were ever bypassed — the same pattern
   * transactions.service.ts's deductInventoryForSale already uses for the
   * POS sale-deduction hot path.
   */
  /**
   * `unitCost`, when passed, absolute-sets InventoryStock.unitCost in the
   * same update as the quantity increment (e.g. the newly-computed weighted
   * average from a costed receiving) — omit it for cost-agnostic writers
   * (adjustment/waste/transfer-out) that must not disturb the existing
   * carrying cost.
   */
  incrementStockQuantity(
    branchId: string,
    inventoryItemId: string,
    delta: Prisma.Decimal | number,
    tx: Prisma.TransactionClient,
    unitCost?: Prisma.Decimal,
  ) {
    return tx.inventoryStock.update({
      where: { branchId_inventoryItemId: { branchId, inventoryItemId } },
      data: {
        quantityOnHand: { increment: delta },
        version: { increment: 1 },
        ...(unitCost !== undefined ? { unitCost } : {}),
      },
    });
  },

  createStockMovement(input: CreateStockMovementInput, tx: Prisma.TransactionClient) {
    return tx.inventoryStockMovement.create({
      data: {
        branchId: input.branchId,
        inventoryItemId: input.inventoryItemId,
        movementType: input.movementType,
        quantityChange: input.quantityChange,
        quantityBefore: input.quantityBefore,
        quantityAfter: input.quantityAfter,
        unitId: input.unitId,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        notes: input.notes,
        performedByUserId: input.performedByUserId,
        unitCost: input.unitCost,
        totalCost: input.totalCost,
        responsibleUserId: input.responsibleUserId,
        enteredQuantity: input.enteredQuantity,
        enteredUnitId: input.enteredUnitId,
        proofKey: input.proofKey,
        proofType: input.proofType,
      },
      include: stockMovementInclude,
    });
  },

  /** Branch-scoped lookup used to authorize a proof-photo upload/read before touching Storage — mirrors expensesRepository's find-then-assertBranchAccess pattern. */
  findMovementById(id: string) {
    return prisma.inventoryStockMovement.findUnique({ where: { id }, include: stockMovementInclude });
  },

  updateMovementProof(id: string, proofKey: string | null, proofType: InventoryProofType | null) {
    return prisma.inventoryStockMovement.update({ where: { id }, data: { proofKey, proofType }, include: stockMovementInclude });
  },

  /** Batch name lookup for movement/correction history display — InventoryStockMovement.performedByUserId/responsibleUserId are loose references, not Prisma relations (the entity referenced varies), so this is a manual findMany + map, same pattern as reports.repository.ts's recorderIds lookup. */
  findUsersByIds(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
  },

  // --- Cost correction (Receiving Simplification V2 §12-15) ---

  /** The one sanctioned direct-mutation path for InventoryStock.unitCost outside the RECEIVING/TRANSFER_IN weighted-average blend. Must be called after lockAndGetStock inside the same transaction. */
  setStockUnitCost(branchId: string, inventoryItemId: string, unitCost: Prisma.Decimal, tx: Prisma.TransactionClient) {
    return tx.inventoryStock.update({
      where: { branchId_inventoryItemId: { branchId, inventoryItemId } },
      data: { unitCost, version: { increment: 1 } },
    });
  },

  createCostCorrection(data: CreateInventoryCostCorrectionData & { oldUnitCost: Prisma.Decimal | null; quantityOnHand: Prisma.Decimal; valuationDifference: Prisma.Decimal; correctedByUserId: string }, tx: Prisma.TransactionClient) {
    return tx.inventoryCostCorrection.create({
      data: {
        branchId: data.branchId,
        inventoryItemId: data.inventoryItemId,
        oldUnitCost: data.oldUnitCost,
        newUnitCost: data.newUnitCost,
        quantityOnHand: data.quantityOnHand,
        valuationDifference: data.valuationDifference,
        reasonCode: data.reasonCode,
        notes: data.notes,
        correctedByUserId: data.correctedByUserId,
      },
      include: costCorrectionInclude,
    });
  },

  findCostCorrectionById(id: string) {
    return prisma.inventoryCostCorrection.findUnique({ where: { id }, include: costCorrectionInclude });
  },

  updateCostCorrectionProof(id: string, proofKey: string | null, proofType: InventoryProofType | null) {
    return prisma.inventoryCostCorrection.update({ where: { id }, data: { proofKey, proofType }, include: costCorrectionInclude });
  },

  async findCostCorrections(
    branchId: string,
    filters: { inventoryItemId?: string; page: number; limit: number },
  ) {
    const where: Prisma.InventoryCostCorrectionWhereInput = {
      branchId,
      ...(filters.inventoryItemId && { inventoryItemId: filters.inventoryItemId }),
    };
    const [corrections, total] = await Promise.all([
      prisma.inventoryCostCorrection.findMany({
        where,
        include: costCorrectionInclude,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.inventoryCostCorrection.count({ where }),
    ]);
    return { corrections, total };
  },

  /**
   * Batched counterpart to createStockMovement — one round trip for many
   * ledger rows instead of one `create` per row. No `include`/return rows
   * (createMany can't return them); use this only where callers don't need
   * the created movement rows back (e.g. deductInventoryForSale, which
   * already has everything it needs from the paired InventoryStock.update
   * result).
   */
  createStockMovements(inputs: CreateStockMovementInput[], tx: Prisma.TransactionClient) {
    return tx.inventoryStockMovement.createMany({
      data: inputs.map((input) => ({
        branchId: input.branchId,
        inventoryItemId: input.inventoryItemId,
        movementType: input.movementType,
        quantityChange: input.quantityChange,
        quantityBefore: input.quantityBefore,
        quantityAfter: input.quantityAfter,
        unitId: input.unitId,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        notes: input.notes,
        performedByUserId: input.performedByUserId,
      })),
    });
  },

  /** Every active, tracked InventoryItem's stock row at this branch — the sole Branch Inventory list data source (brief §2). */
  findBranchStockRows(branchId: string) {
    return prisma.inventoryStock.findMany({
      where: { branchId, inventoryItem: { deletedAt: null, trackInventory: true } },
      include: { inventoryItem: { include: inventoryItemInclude } },
      orderBy: { inventoryItem: { name: 'asc' } },
    });
  },

  /** SALE-movement quantity consumed per item today (Manila calendar day), for the Branch Inventory list's "Consumed Today" column. */
  async getConsumedTodayByBranch(branchId: string, dayStart: Date, dayEnd: Date): Promise<Map<string, number>> {
    const grouped = await prisma.inventoryStockMovement.groupBy({
      by: ['inventoryItemId'],
      where: { branchId, movementType: 'SALE', createdAt: { gte: dayStart, lte: dayEnd } },
      _sum: { quantityChange: true },
    });
    return new Map(grouped.map((g) => [g.inventoryItemId, Math.abs(g._sum.quantityChange?.toNumber() ?? 0)]));
  },

  findStock(branchId: string, inventoryItemId: string) {
    return prisma.inventoryStock.findUnique({
      where: { branchId_inventoryItemId: { branchId, inventoryItemId } },
      include: { inventoryItem: { include: inventoryItemInclude } },
    });
  },

  async findStockMovements(
    branchId: string,
    filters: { inventoryItemId?: string; movementType?: InventoryStockMovementType; fromDate?: Date; toDate?: Date; page: number; limit: number },
  ) {
    const where: Prisma.InventoryStockMovementWhereInput = {
      branchId,
      ...(filters.inventoryItemId && { inventoryItemId: filters.inventoryItemId }),
      ...(filters.movementType && { movementType: filters.movementType }),
      ...((filters.fromDate ?? filters.toDate) && {
        createdAt: {
          ...(filters.fromDate && { gte: filters.fromDate }),
          ...(filters.toDate && { lte: filters.toDate }),
        },
      }),
    };

    const [movements, total] = await Promise.all([
      prisma.inventoryStockMovement.findMany({
        where,
        include: stockMovementInclude,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.inventoryStockMovement.count({ where }),
    ]);

    return { movements, total };
  },
};
