import type { APIRequestContext } from '@playwright/test';
import { TEST_USERS } from './test-users';
import { apiLogin, authedPost } from './api-helpers';

export const UNIVERSAL_ITEM_FIXTURE = {
  categoryName: 'E2E Cancellation Category',
  unitCode: 'e2e-pc',
  unitName: 'E2E Piece',
  itemName: 'E2E Cancellation Item',
};

/**
 * Creates a universal-inventory item (category + base unit + item) and
 * assigns it to branchId, through the real admin API — the same path
 * POS-PERF-P28's manual-inventory-approval queue operates on. Assignment
 * itself creates the zero-quantity InventoryStock row (see
 * universal-inventory.repository.ts#assignToBranch), which is what makes
 * the item selectable in the branch Adjust Stock form's dropdown.
 */
export async function seedUniversalItem(request: APIRequestContext, baseURL: string, branchId: string): Promise<{ inventoryItemId: string }> {
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);

  const category = await authedPost<{ id: string }>(request, baseURL, '/api/universal-inventory/categories', admin.accessToken, {
    name: UNIVERSAL_ITEM_FIXTURE.categoryName,
  });
  if (!category.data?.id && category.status !== 409) {
    throw new Error(`Failed to seed category (${category.status}): ${JSON.stringify(category.error)}`);
  }

  const unit = await authedPost<{ id: string }>(request, baseURL, '/api/universal-inventory/units', admin.accessToken, {
    code: UNIVERSAL_ITEM_FIXTURE.unitCode,
    name: UNIVERSAL_ITEM_FIXTURE.unitName,
    dimension: 'COUNT',
    is_base_unit: true,
  });
  if (!unit.data?.id && unit.status !== 409) {
    throw new Error(`Failed to seed unit (${unit.status}): ${JSON.stringify(unit.error)}`);
  }

  // Either call may have 409'd on a re-run against a non-fresh database —
  // fetch the authoritative ids rather than trusting the create response.
  const categories = await request.get('/api/universal-inventory/categories', { headers: { Authorization: `Bearer ${admin.accessToken}` } });
  const categoriesBody = (await categories.json()) as { data: { categories: { id: string; name: string }[] } };
  const categoryId = categoriesBody.data.categories.find((c) => c.name === UNIVERSAL_ITEM_FIXTURE.categoryName)?.id;

  const units = await request.get('/api/universal-inventory/units', { headers: { Authorization: `Bearer ${admin.accessToken}` } });
  const unitsBody = (await units.json()) as { data: { units: { id: string; code: string }[] } };
  const unitId = unitsBody.data.units.find((u) => u.code === UNIVERSAL_ITEM_FIXTURE.unitCode)?.id;

  if (!categoryId || !unitId) throw new Error('Failed to resolve seeded category/unit id');

  const item = await authedPost<{ id: string }>(request, baseURL, '/api/universal-inventory/items', admin.accessToken, {
    name: UNIVERSAL_ITEM_FIXTURE.itemName,
    category_id: categoryId,
    base_unit_id: unitId,
    track_inventory: true,
  });
  let inventoryItemId = item.data?.id;
  if (!inventoryItemId && item.status === 409) {
    // Re-run against a non-fresh database: resolve the existing item by name.
    const items = await request.get('/api/universal-inventory/items', { headers: { Authorization: `Bearer ${admin.accessToken}` } });
    const itemsBody = (await items.json()) as { data: { items: { id: string; name: string }[] } };
    inventoryItemId = itemsBody.data.items.find((i) => i.name === UNIVERSAL_ITEM_FIXTURE.itemName)?.id;
  }
  if (!inventoryItemId) {
    throw new Error(`Failed to seed inventory item (${item.status}): ${JSON.stringify(item.error)}`);
  }

  const assignment = await authedPost(request, baseURL, `/api/universal-inventory/items/${inventoryItemId}/branches`, admin.accessToken, {
    branch_ids: [branchId],
  });
  if (assignment.status !== 200 && assignment.status !== 409) {
    throw new Error(`Failed to assign item to branch (${assignment.status}): ${JSON.stringify(assignment.error)}`);
  }

  return { inventoryItemId };
}
