-- CR-005 Phase 2 Part A: Backfill flavor->ingredient linkage
-- and provision per-branch flavor Ingredient rows

-- Step A1: Populate ingredient_name from flavor name where null
UPDATE flavors
SET ingredient_name = name
WHERE ingredient_name IS NULL;

-- Step A2: Populate ingredient_unit with default unit where null
UPDATE flavors
SET ingredient_unit = 'grams'
WHERE ingredient_unit IS NULL;

-- Step A3: Provision Ingredient rows per branch per flavor
-- Idempotent on (branch_id, name) WHERE deleted_at IS NULL, matching the
-- real "ingredients_branch_id_name_key" partial unique index and the
-- CR-004 provisionIngredient() resolver, which also matches on
-- (branchId, name) only -- unit is not part of ingredient identity.
INSERT INTO ingredients (
  id,
  branch_id,
  name,
  unit,
  category,
  current_stock,
  low_stock_threshold,
  critical_threshold,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid()::text,
  b.id,
  f.ingredient_name,
  f.ingredient_unit,
  'FLAVOR'::"IngredientCategory",
  0,
  0,
  0,
  NOW(),
  NOW()
FROM branches b
CROSS JOIN flavors f
WHERE NOT EXISTS (
  SELECT 1
  FROM ingredients i
  WHERE i.branch_id = b.id
    AND i.name = f.ingredient_name
    AND i.deleted_at IS NULL
);
