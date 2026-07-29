# Post-Baseline Plan: `add_inventory_item_stock_unit_cost`

Review-only. Nothing in this document is executed automatically, and none of
it was executed as part of generating this plan. Each step must be run
manually and reviewed before moving to the next.

Prerequisite: `apps/api/scripts/baseline-existing-migrations.sh` has been
reviewed, run, and confirmed successful (58 migrations baselined).

## 1. Confirm baseline state

```
npx prisma migrate status
```

Expected:
- 58 migrations applied
- 1 pending: `20260729190000_add_inventory_item_stock_unit_cost`

Do not proceed if the applied count is not exactly 58, or if more than one
migration is reported pending.

## 2. Apply the pending migration

```
npx prisma migrate deploy
```

Expected:
- Only `20260729190000_add_inventory_item_stock_unit_cost` is applied.
- No other migration is executed (all others are already marked applied from
  step 1's baseline).

## 3. Confirm fully up to date

```
npx prisma migrate status
```

Expected:
- Database schema is up to date.
- All 59 migrations report as applied.

## 4. Verify new columns (read-only SQL)

```sql
SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
FROM information_schema.columns
WHERE table_name = 'inventory_items' AND column_name = 'unit_cost';

SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
FROM information_schema.columns
WHERE table_name = 'inventory_stocks' AND column_name = 'unit_cost';
```

Expected for both:
- `data_type`: `numeric` (decimal), precision/scale consistent with
  `decimal(10,4)`
- `is_nullable`: `YES`

## 5. Smoke test

```
GET /api/reports/inventory-valuation-rollup
```

Expected:
- HTTP 200
- No missing-column error

## 6. Rollback reference only — do not run unless the migration must be reversed

```sql
ALTER TABLE inventory_items DROP COLUMN unit_cost;
ALTER TABLE inventory_stocks DROP COLUMN unit_cost;
```

**Warning:** this is destructive and irreversible without a backup. Only run
this if the migration must be reversed, and only after confirming with the
team. Do not run it as part of routine verification.
