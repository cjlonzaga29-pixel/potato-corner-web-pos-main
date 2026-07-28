import { Prisma } from '@prisma/client';
import { productInventoryRepository } from './product-inventory.repository.js';
import { ProductInventoryError, type DeductionLine } from './product-inventory.types.js';
import { productsRepository } from '../products/products.repository.js';
import { inventoryRepository } from '../inventory/inventory.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

type ActorContext = { id: string; role: string };

interface ProductInventoryRow {
  id: string;
  productVariantId: string;
  ingredientId: string;
  quantityRequired: { toNumber(): number };
  unit: string;
  createdAt: Date;
  updatedAt: Date;
  ingredient: { name: string };
}

function toResponse(row: ProductInventoryRow) {
  return {
    id: row.id,
    product_variant_id: row.productVariantId,
    ingredient_id: row.ingredientId,
    ingredient_name: row.ingredient.name,
    quantity_required: row.quantityRequired.toNumber(),
    unit: row.unit,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

interface CreateProductInventoryInput {
  branch_id: string;
  product_variant_id: string;
  ingredient_id: string;
  quantity_required: number;
  unit: string;
}

interface UpdateProductInventoryInput {
  quantity_required?: number;
  unit?: string;
}

function mappingExistsError(): ProductInventoryError {
  return new ProductInventoryError(
    'PRODUCT_INVENTORY_MAPPING_EXISTS',
    'A mapping for this product variant and inventory item already exists',
    409,
  );
}

interface ComputeDeductionInput {
  productVariantId: string;
  flavorId: string | null;
  quantitySold: number;
  branchId?: string;
}

interface MappingIngredientRef {
  ingredientId: string;
  ingredient: { name: string; branchId: string };
}

/**
 * CR-004: a ProductInventory mapping row's ingredientId points at one
 * specific branch's Ingredient (Ingredient has no branch-neutral identity —
 * see docs/decisions/CR-004-pos-deduction-integrity.md). A sale at any
 * *other* branch must resolve that row to its own equivalent Ingredient
 * (matched by name — the same match findIngredientByBranchAndName and
 * idempotent branch provisioning both use), never deduct against the pinned
 * branch's stock. A no-op (zero extra queries) when the row's own ingredient
 * already belongs to the selling branch, which covers every single-branch
 * deployment and every mapping an admin happened to create against that
 * branch's ingredient.
 */
async function resolveIngredientForBranch(branchId: string, row: MappingIngredientRef): Promise<{ id: string; name: string }> {
  if (row.ingredient.branchId === branchId) {
    return { id: row.ingredientId, name: row.ingredient.name };
  }
  const resolved = await inventoryRepository.findIngredientByBranchAndName(branchId, row.ingredient.name);
  if (!resolved) {
    throw new ProductInventoryError(
      'INGREDIENT_NOT_PROVISIONED',
      `Ingredient "${row.ingredient.name}" has not been provisioned at this branch yet — add it under branch inventory before selling this item here`,
      409,
    );
  }
  return { id: resolved.id, name: resolved.name };
}

/**
 * Computes ingredient deductions for a POS sale from active ProductInventory
 * mappings for the given branch and product variant (see
 * productInventoryRepository.findByVariantForDeduction) — that query already
 * excludes soft-deleted (deletedAt) and inactive (isActive: false) mappings,
 * so every row returned here is eligible to deduct. branchId is required;
 * this function does not read the Recipe or BranchRecipeOverride tables.
 *
 * Layering order (a later step replaces a same-ingredient_id entry from an
 * earlier step, or adds a new one):
 *   1. base mappings    (flavor_id IS NULL)
 *   2. flavor mappings   (flavor_id = selected) — overrides same-ingredient base
 *
 * Each mapping's ingredient is resolved to the selling branch's own
 * Ingredient (CR-004, resolveIngredientForBranch) before being added to the
 * result.
 */
export async function computeDeduction(input: ComputeDeductionInput): Promise<DeductionLine[]> {
  if (!input.branchId) {
    throw new ProductInventoryError('BRANCH_ID_REQUIRED', 'A branchId is required to compute inventory deduction.', 400);
  }
  const rows = await productInventoryRepository.findByVariantForDeduction(
    input.branchId,
    input.productVariantId,
    input.flavorId ?? undefined,
  );

  // Query order is not guaranteed, so partition explicitly: base mappings
  // (flavorId null) are applied first, flavor mappings second, so a flavor
  // mapping always wins over a base mapping for the same ingredientId
  // regardless of the row order the DB returns.
  const baseRows = rows.filter((row) => row.flavorId === null);
  const flavorRows = rows.filter((row) => row.flavorId !== null);

  const map = new Map<string, DeductionLine>();
  for (const row of [...baseRows, ...flavorRows]) {
    const ingredient = input.branchId
      ? await resolveIngredientForBranch(input.branchId, { ingredientId: row.ingredientId, ingredient: { name: row.ingredient.name, branchId: row.ingredient.branchId } })
      : { id: row.ingredientId, name: row.ingredient.name };
    map.set(ingredient.id, {
      ingredient_id: ingredient.id,
      ingredient_name: ingredient.name,
      quantity: row.quantityRequired.toNumber(),
      unit: row.unit,
      source: 'master_base',
    });
  }

  return Array.from(map.values()).map((line) => ({ ...line, quantity: line.quantity * input.quantitySold }));
}

interface ComputeDeductionForSlotsInput {
  /** The Mix & Max parent variant — used only to resolve its own packaging (box/cup) mappings, never the snack ingredients themselves. */
  productVariantId: string;
  selectedFlavors: { slotIndex: number; snackProductVariantId: string; flavorId: string }[];
  quantitySold: number;
  branchId: string;
}

/**
 * Phase 5 (Mix & Max snack selection): the parent Mix & Max variant's own
 * base mappings (flavor_id IS NULL) represent packaging (box/cup), resolved
 * once regardless of slot count. Each slot's actual ingredient deduction is
 * resolved against the *selected snack's own* ProductInventory (its base
 * mappings + its selected flavor's mappings) via computeDeduction — never
 * against the parent variant. Repeated snack/flavor picks across slots sum
 * rather than overwrite, since each is a genuinely separate consumption.
 */
export async function computeDeductionForSlots(input: ComputeDeductionForSlotsInput): Promise<DeductionLine[]> {
  if (!input.branchId) {
    throw new ProductInventoryError('BRANCH_ID_REQUIRED', 'A branchId is required to compute inventory deduction.', 400);
  }

  const packagingRows = await productInventoryRepository.findByVariantForDeduction(input.branchId, input.productVariantId);
  const map = new Map<string, DeductionLine>();
  for (const row of packagingRows) {
    const ingredient = await resolveIngredientForBranch(input.branchId, { ingredientId: row.ingredientId, ingredient: { name: row.ingredient.name, branchId: row.ingredient.branchId } });
    const existing = map.get(ingredient.id);
    map.set(ingredient.id, {
      ingredient_id: ingredient.id,
      ingredient_name: ingredient.name,
      quantity: (existing?.quantity ?? 0) + row.quantityRequired.toNumber(),
      unit: row.unit,
      source: 'master_base',
    });
  }

  for (const selection of input.selectedFlavors) {
    const lines = await computeDeduction({
      productVariantId: selection.snackProductVariantId,
      flavorId: selection.flavorId,
      quantitySold: 1,
      branchId: input.branchId,
    });
    for (const line of lines) {
      const existing = map.get(line.ingredient_id);
      map.set(line.ingredient_id, { ...line, quantity: (existing?.quantity ?? 0) + line.quantity });
    }
  }

  return Array.from(map.values()).map((line) => ({ ...line, quantity: line.quantity * input.quantitySold }));
}

/**
 * CR-004: transactions.service.ts calls this before pricing a cart line —
 * a sale must never be recorded for a variant with zero recipe rows, since
 * computeDeduction would silently return an empty deduction list (i.e. "sell
 * it for free, deduct nothing") rather than signal that no one has
 * configured the recipe yet. Checked against ProductInventory since that's
 * computeDeduction's actual data source (see findByVariantForDeduction
 * above) — not the legacy Recipe table.
 */
export async function assertProductInventoryExists(branchId: string, productVariantId: string): Promise<void> {
  const exists = await productInventoryRepository.hasMappingForVariant(branchId, productVariantId);
  if (!exists) {
    throw new ProductInventoryError(
      'RECIPE_MISSING',
      'This product variant has no recipe configured — a sale cannot be recorded until Super Admin adds one',
      422,
    );
  }
}

export const productInventoryService = {
  async listByVariant(branchId: string, productVariantId: string) {
    const rows = (await productInventoryRepository.findByVariant(branchId, productVariantId)) as ProductInventoryRow[];
    return rows.map(toResponse);
  },

  /**
   * branchIds ('all' for super_admin, else the caller's allowed branch_ids —
   * see lib/branch-access.ts) gates data.branch_id itself before anything is
   * looked up, and the ingredient is then resolved scoped to that same
   * branch_id so a cross-branch ingredient never passes as a valid mapping
   * target — mirrors updateMapping/deleteMapping's branch-scoping.
   */
  async createMapping(data: CreateProductInventoryInput, branchIds: string[] | 'all', actor: ActorContext, ipAddress: string | null) {
    if (branchIds !== 'all' && !branchIds.includes(data.branch_id)) {
      throw new ProductInventoryError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
    }

    const variant = await productsRepository.findVariantById(data.product_variant_id);
    if (!variant) throw new ProductInventoryError('VARIANT_NOT_FOUND', 'Product variant not found', 404);

    const ingredient = await productInventoryRepository.findIngredientForBranch(data.ingredient_id, data.branch_id);
    if (!ingredient) throw new ProductInventoryError('INGREDIENT_NOT_FOUND', 'Inventory item not found', 404);

    const existing = await productInventoryRepository.findByVariantAndIngredient(data.branch_id, data.product_variant_id, data.ingredient_id);
    if (existing) throw mappingExistsError();

    let created: ProductInventoryRow;
    try {
      created = (await productInventoryRepository.create({
        branchId: data.branch_id,
        productVariantId: data.product_variant_id,
        ingredientId: data.ingredient_id,
        quantityRequired: data.quantity_required,
        unit: data.unit,
      })) as ProductInventoryRow;
    } catch (error) {
      // Belt-and-suspenders against the findByVariantAndIngredient check
      // above racing a concurrent create — @@unique([productVariantId,
      // ingredientId]) in schema.prisma is the actual guarantee.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw mappingExistsError();
      }
      throw error;
    }
    const response = toResponse(created);

    await recordAuditLog({
      action: 'PRODUCT_INVENTORY_CREATED',
      entityType: 'product_inventory',
      entityId: created.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  /**
   * branchIds ('all' for super_admin, else the caller's allowed branch_ids —
   * see lib/branch-access.ts) scopes both the existence check and the write
   * itself, so a mapping owned by another branch behaves as not found rather
   * than revealing it exists elsewhere.
   */
  async updateMapping(id: string, data: UpdateProductInventoryInput, branchIds: string[] | 'all', actor: ActorContext, ipAddress: string | null) {
    const existing = (await productInventoryRepository.findById(id, branchIds)) as ProductInventoryRow | null;
    if (!existing) throw new ProductInventoryError('PRODUCT_INVENTORY_NOT_FOUND', 'ProductInventory mapping not found', 404);

    const result = await productInventoryRepository.update(
      id,
      {
        quantityRequired: data.quantity_required,
        unit: data.unit,
      },
      branchIds,
    );
    if (result.count === 0) throw new ProductInventoryError('PRODUCT_INVENTORY_NOT_FOUND', 'ProductInventory mapping not found', 404);

    const updated = (await productInventoryRepository.findById(id, branchIds)) as ProductInventoryRow;
    const response = toResponse(updated);

    await recordAuditLog({
      action: 'PRODUCT_INVENTORY_UPDATED',
      entityType: 'product_inventory',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toResponse(existing),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async deleteMapping(id: string, branchIds: string[] | 'all', actor: ActorContext, ipAddress: string | null) {
    const existing = (await productInventoryRepository.findById(id, branchIds)) as ProductInventoryRow | null;
    if (!existing) throw new ProductInventoryError('PRODUCT_INVENTORY_NOT_FOUND', 'ProductInventory mapping not found', 404);

    const result = await productInventoryRepository.delete(id, branchIds, actor.id);
    if (result.count === 0) throw new ProductInventoryError('PRODUCT_INVENTORY_NOT_FOUND', 'ProductInventory mapping not found', 404);

    await recordAuditLog({
      action: 'PRODUCT_INVENTORY_DELETED',
      entityType: 'product_inventory',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toResponse(existing),
      ipAddress,
    });
  },
};
