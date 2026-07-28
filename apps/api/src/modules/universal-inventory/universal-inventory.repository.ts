import { prisma } from '../../lib/prisma.js';
import type {
  CreateInventoryCategoryData,
  UpdateInventoryCategoryData,
  CreateUnitOfMeasureData,
  UpdateUnitOfMeasureData,
  CreateUnitConversionData,
  CreateInventoryItemData,
  UpdateInventoryItemData,
} from './universal-inventory.types.js';

const inventoryItemInclude = {
  category: { select: { id: true, name: true } },
  baseUnit: { select: { id: true, code: true, name: true } },
} as const;

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
};
