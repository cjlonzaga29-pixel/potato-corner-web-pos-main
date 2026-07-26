import { SOCKET_EVENTS } from '@potato-corner/shared';
import { recipesRepository } from './recipes.repository.js';
import { RecipeError, type DeductionLine } from './recipes.types.js';
import { productsRepository } from '../products/products.repository.js';
import { inventoryRepository } from '../inventory/inventory.repository.js';
import { productInventoryRepository } from '../product-inventory/product-inventory.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { notifySuperAdmin } from '../../lib/notify.js';

type ActorContext = { id: string; role: string };

interface RecipeRow {
  id: string;
  productVariantId: string;
  ingredientId: string;
  flavorId: string | null;
  quantity: { toNumber(): number };
  unit: string;
  ingredient: { name: string; branchId: string };
  flavor: { name: string } | null;
}

/**
 * Master Recipe rows carry `version` (CR-004) and `flavorSlotIndex` (CR-005
 * 3f); BranchRecipeOverride rows have neither column.
 */
interface MasterRecipeRow extends RecipeRow {
  version: number;
  flavorSlotIndex: number | null;
}

interface OverrideRow extends RecipeRow {
  branchId: string;
  reason: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function toRecipeResponse(row: RecipeRow) {
  return {
    id: row.id,
    product_variant_id: row.productVariantId,
    ingredient_id: row.ingredientId,
    ingredient_name: row.ingredient.name,
    flavor_id: row.flavorId,
    flavor_name: row.flavor?.name ?? null,
    quantity: row.quantity.toNumber(),
    unit: row.unit,
  };
}

/** CR-004/CR-005 3f: master recipe responses carry `version` and `flavor_slot_index`; BranchRecipeOverride responses (toOverrideResponse below) carry neither. */
function toMasterRecipeResponse(row: MasterRecipeRow) {
  return { ...toRecipeResponse(row), version: row.version, flavor_slot_index: row.flavorSlotIndex };
}

function toOverrideResponse(row: OverrideRow) {
  return {
    ...toRecipeResponse(row),
    branch_id: row.branchId,
    reason: row.reason,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

interface CreateRecipeInput {
  product_variant_id: string;
  ingredient_id: string;
  flavor_id?: string | null;
  flavor_slot_index?: number | null;
  quantity: number;
  unit: string;
}

interface UpdateRecipeInput {
  quantity?: number;
  unit?: string;
  flavor_slot_index?: number | null;
  // flavor_id is intentionally not editable here — flavor targeting is set
  // at create time only. To switch a recipe from flavor-specific to
  // slot-based, delete and recreate it.
}

interface CreateOverrideInput {
  branch_id: string;
  ingredient_id: string;
  flavor_id?: string | null;
  quantity: number;
  unit: string;
  reason: string;
}

interface UpdateOverrideInput {
  quantity?: number;
  unit?: string;
  reason: string;
}

interface ComputeDeductionInput {
  productVariantId: string;
  flavorId: string | null;
  quantitySold: number;
  branchId?: string;
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
async function resolveIngredientForBranch(branchId: string, row: RecipeRow): Promise<{ id: string; name: string }> {
  if (row.ingredient.branchId === branchId) {
    return { id: row.ingredientId, name: row.ingredient.name };
  }
  const resolved = await inventoryRepository.findIngredientByBranchAndName(branchId, row.ingredient.name);
  if (!resolved) {
    throw new RecipeError(
      'INGREDIENT_NOT_PROVISIONED',
      `Ingredient "${row.ingredient.name}" has not been provisioned at this branch yet — add it under branch inventory before selling this item here`,
      409,
    );
  }
  return { id: resolved.id, name: resolved.name };
}

/**
 * CR-005 3f — a Recipe row targets a flavor exactly one of two ways: a fixed
 * Flavor (flavorId) or a position in the variant's ProductFlavorSlot list
 * (flavorSlotIndex). Shared by createRecipe and updateRecipe so both enforce
 * the same mutual-exclusivity and range rules.
 */
async function assertRecipeFlavorTargetingValid(
  productVariantId: string,
  flavorId: string | null | undefined,
  flavorSlotIndex: number | null | undefined,
): Promise<void> {
  if (flavorId != null && flavorSlotIndex != null) {
    throw new RecipeError('RECIPE_FLAVOR_AMBIGUOUS', 'Recipe cannot specify both flavorId and flavorSlotIndex.', 400);
  }

  if (flavorSlotIndex != null) {
    const slotCount = await productsRepository.countVariantFlavorSlots(productVariantId);
    if (slotCount === 0) {
      throw new RecipeError(
        'RECIPE_SLOT_INDEX_ON_SLOTLESS_VARIANT',
        'Cannot set flavorSlotIndex on a variant with zero flavor slots.',
        400,
      );
    }
    if (flavorSlotIndex < 0 || flavorSlotIndex >= slotCount) {
      throw new RecipeError(
        'RECIPE_SLOT_INDEX_OUT_OF_RANGE',
        `flavorSlotIndex ${flavorSlotIndex} out of range [0, ${slotCount - 1}] for variant ${productVariantId}.`,
        400,
      );
    }
  }
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
    throw new RecipeError('BRANCH_ID_REQUIRED', 'A branchId is required to compute inventory deduction.', 400);
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
      ? await resolveIngredientForBranch(
          input.branchId,
          { ingredientId: row.ingredientId, ingredient: { name: row.ingredient.name, branchId: row.ingredient.branchId } } as unknown as RecipeRow,
        )
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
    throw new RecipeError(
      'RECIPE_MISSING',
      'This product variant has no recipe configured — a sale cannot be recorded until Super Admin adds one',
      422,
    );
  }
}

export const recipesService = {
  async listRecipes(productVariantId: string) {
    const rows = (await recipesRepository.findByVariant(productVariantId)) as MasterRecipeRow[];
    return rows.map(toMasterRecipeResponse);
  },

  async createRecipe(data: CreateRecipeInput, actor: ActorContext, ipAddress: string | null) {
    const variant = await productsRepository.findVariantById(data.product_variant_id);
    if (!variant) throw new RecipeError('VARIANT_NOT_FOUND', 'Product variant not found', 404);

    await assertRecipeFlavorTargetingValid(data.product_variant_id, data.flavor_id ?? null, data.flavor_slot_index ?? null);

    const created = (await recipesRepository.createRecipe({
      productVariantId: data.product_variant_id,
      ingredientId: data.ingredient_id,
      flavorId: data.flavor_id ?? null,
      flavorSlotIndex: data.flavor_slot_index ?? null,
      quantity: data.quantity,
      unit: data.unit,
    })) as MasterRecipeRow;
    const response = toMasterRecipeResponse(created);

    await recordAuditLog({
      action: 'RECIPE_CREATED',
      entityType: 'recipe',
      entityId: created.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateRecipe(recipeId: string, data: UpdateRecipeInput, actor: ActorContext, ipAddress: string | null) {
    const existing = (await recipesRepository.findRecipeById(recipeId)) as MasterRecipeRow | null;
    if (!existing) throw new RecipeError('RECIPE_NOT_FOUND', 'Recipe not found', 404);

    // undefined = no change; explicit null = clear.
    const nextFlavorSlotIndex = data.flavor_slot_index !== undefined ? data.flavor_slot_index : existing.flavorSlotIndex;
    await assertRecipeFlavorTargetingValid(existing.productVariantId, existing.flavorId, nextFlavorSlotIndex);

    const updated = (await recipesRepository.updateRecipe(recipeId, {
      quantity: data.quantity,
      unit: data.unit,
      flavorSlotIndex: data.flavor_slot_index,
    })) as MasterRecipeRow;
    const response = toMasterRecipeResponse(updated);

    await recordAuditLog({
      action: 'RECIPE_UPDATED',
      entityType: 'recipe',
      entityId: recipeId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toMasterRecipeResponse(existing),
      afterState: response,
      ipAddress,
    });

    // CR-005 3f — lets a Phase 4 POS listener invalidate any cached recipe
    // for this variant once flavorSlotIndex rows are resolved at sale time.
    notifySuperAdmin(SOCKET_EVENTS.RECIPE_UPDATED, {
      recipe_id: recipeId,
      product_variant_id: updated.productVariantId,
      version: updated.version,
    });

    return response;
  },

  async deleteRecipe(recipeId: string, actor: ActorContext, ipAddress: string | null) {
    const existing = (await recipesRepository.findRecipeById(recipeId)) as MasterRecipeRow | null;
    if (!existing) throw new RecipeError('RECIPE_NOT_FOUND', 'Recipe not found', 404);

    await recipesRepository.deleteRecipe(recipeId);

    await recordAuditLog({
      action: 'RECIPE_DELETED',
      entityType: 'recipe',
      entityId: recipeId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toMasterRecipeResponse(existing),
      ipAddress,
    });
  },

  async simulateDeduction(input: {
    product_variant_id: string;
    flavor_id?: string | null;
    quantity_sold: number;
    branch_id?: string;
  }) {
    const lines = await computeDeduction({
      productVariantId: input.product_variant_id,
      flavorId: input.flavor_id ?? null,
      quantitySold: input.quantity_sold,
      branchId: input.branch_id,
    });
    return {
      product_variant_id: input.product_variant_id,
      flavor_id: input.flavor_id ?? null,
      branch_id: input.branch_id ?? null,
      quantity_sold: input.quantity_sold,
      lines,
    };
  },

  // --- CR-001 branch overrides (no approval; audit-logged) ---

  async listOverrides(productVariantId: string, branchId: string) {
    const rows = (await recipesRepository.findOverridesByVariantAndBranch(productVariantId, branchId)) as OverrideRow[];
    return rows.map(toOverrideResponse);
  },

  async createOverride(
    productVariantId: string,
    data: CreateOverrideInput,
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    const variant = await productsRepository.findVariantById(productVariantId);
    if (!variant) throw new RecipeError('VARIANT_NOT_FOUND', 'Product variant not found', 404);

    // CR-004: a branch override must reference an Ingredient owned by that
    // same branch — otherwise it would silently deduct another branch's
    // stock the same way an unresolved master recipe used to (see
    // computeDeduction/resolveIngredientForBranch above).
    const ingredient = await inventoryRepository.findIngredientById(data.ingredient_id);
    if (!ingredient || ingredient.branchId !== data.branch_id) {
      throw new RecipeError('INGREDIENT_NOT_IN_BRANCH', 'ingredient_id must belong to the same branch as branch_id', 422);
    }

    const created = (await recipesRepository.createOverride({
      branchId: data.branch_id,
      productVariantId,
      ingredientId: data.ingredient_id,
      flavorId: data.flavor_id ?? null,
      quantity: data.quantity,
      unit: data.unit,
      reason: data.reason,
      createdBy: actor.id,
    })) as OverrideRow;
    const response = toOverrideResponse(created);

    await recordAuditLog({
      action: 'BRANCH_RECIPE_OVERRIDE_CREATED',
      entityType: 'branch_recipe_override',
      entityId: created.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: data.branch_id,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateOverride(overrideId: string, branchId: string, data: UpdateOverrideInput, actor: ActorContext, ipAddress: string | null) {
    const existing = (await recipesRepository.findOverrideById(overrideId)) as OverrideRow | null;
    if (!existing || existing.branchId !== branchId) {
      throw new RecipeError('RECIPE_OVERRIDE_NOT_FOUND', 'Branch recipe override not found', 404);
    }

    const updated = (await recipesRepository.updateOverride(overrideId, {
      quantity: data.quantity,
      unit: data.unit,
      reason: data.reason,
    })) as OverrideRow;
    const response = toOverrideResponse(updated);

    await recordAuditLog({
      action: 'BRANCH_RECIPE_OVERRIDE_UPDATED',
      entityType: 'branch_recipe_override',
      entityId: overrideId,
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      beforeState: toOverrideResponse(existing),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async deleteOverride(overrideId: string, branchId: string, actor: ActorContext, ipAddress: string | null) {
    const existing = (await recipesRepository.findOverrideById(overrideId)) as OverrideRow | null;
    if (!existing || existing.branchId !== branchId) {
      throw new RecipeError('RECIPE_OVERRIDE_NOT_FOUND', 'Branch recipe override not found', 404);
    }

    await recipesRepository.deleteOverride(overrideId);

    await recordAuditLog({
      action: 'BRANCH_RECIPE_OVERRIDE_DELETED',
      entityType: 'branch_recipe_override',
      entityId: overrideId,
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      beforeState: toOverrideResponse(existing),
      ipAddress,
    });
  },
};
