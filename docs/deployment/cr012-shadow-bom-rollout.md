# CR-012.1A — Shadow BOM Deduction: Deployment & Rollout Guide

Read-only, shadow-mode comparison of the legacy `ProductInventory` deduction
against a future `ProductComponent`/BOM deduction, for a completed POS sale
line. **Nothing described in this document changes what actually deducts
inventory.** The legacy deduction remains the only inventory-affecting path;
this feature only records comparison rows for later analysis.

## 0. Guarantees this rollout does not change

- The legacy `ProductInventory` deduction remains authoritative for every
  sale, on every branch, regardless of this feature's configuration.
- No `InventoryMovement` row is ever written by this feature.
- No `InventoryStock` row is ever written or read by this feature.
- Sales totals, receipts, and financial reports are computed exactly as
  before — this feature runs after a sale has already committed and cannot
  affect its response.
- If the shadow comparison throws, times out, or errors, the sale is
  unaffected — the shadow call is fire-and-forget and always `.catch()`-guarded.

## 1. Prerequisites

- The CR-012.1 migration (`20260728160000_cr012_1_shadow_bom_comparison`,
  which creates the `ShadowBomComparison` table) has already been applied to
  the target database. Confirm with:
  ```
  pnpm --filter @potato-corner/api exec prisma migrate status
  ```
- Recipe/BOM data (`ProductComponent` rows) exists for at least the pilot
  branch's active product variants — otherwise every comparison will resolve
  to `BOM_NOT_READY` and provide no signal. Check readiness first via the
  Recipe Readiness report (`/admin/recipe-readiness`) or:
  ```
  pnpm --filter @potato-corner/api exec tsx scripts/recipe-readiness-report.ts
  ```

## 2. Back up the database before applying any new migration

This CR does not introduce a new migration beyond the CR-012.1 table (already
applied per §1) — the branch-rollout config added in this phase
(`SHADOW_BOM_DEDUCTION_BRANCH_IDS`) is an environment variable only, not a
schema change. If a future migration is bundled with this deploy, take a
fresh database backup/snapshot first and confirm it is restorable before
proceeding.

## 3. Review the migration (if any is bundled with this deploy)

- Confirm the migration only touches `ShadowBomComparison`-related objects
  (or is a no-op for this CR).
- Confirm it contains no `DROP`, no destructive `ALTER` on existing
  POS/inventory tables, and no data backfill against live inventory tables.
- **Do not apply migrations to production as part of this rollout — that is
  a separate, explicitly-approved step outside this document's scope.**

## 4. Required environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SHADOW_BOM_DEDUCTION_ENABLED` | `false` | Global on/off switch. `false` means zero shadow calculation and zero `ShadowBomComparison` rows are produced, for every branch, regardless of the branch list below. |
| `SHADOW_BOM_DEDUCTION_BRANCH_IDS` | `` (empty) | Comma-separated list of branch UUIDs. Empty/unset with the global flag `true` means **all branches**. A populated list restricts shadow comparisons to only the listed branch UUIDs. Whitespace around each id is trimmed, duplicates are removed, and any entry that is not a valid UUID **fails config validation at boot** (the app will not start) rather than silently being ignored. |

Both variables are validated once at process boot
(`apps/api/src/config/index.ts`); a malformed `SHADOW_BOM_DEDUCTION_BRANCH_IDS`
value stops the API from starting at all, so a typo is caught immediately
instead of silently no-op'ing in production.

## 5. Deploy with the global flag off

Deploy this code change with `SHADOW_BOM_DEDUCTION_ENABLED=false` (the
default if unset). At this point:

- No shadow comparison runs for any branch.
- The Super Admin dashboard at `/admin/shadow-bom-deduction` is live but will
  show an empty/zero state (no rows exist yet).
- All existing POS, Recipe/BOM, and Recipe Readiness behavior is unchanged.

## 6. Run production role smoke tests

Before enabling any branch, confirm access control in production matches
what the automated test suite already asserts
(`apps/api/src/modules/shadow-bom-deduction/shadow-bom-deduction.router.test.ts`):

- **Super Admin** — can open `/admin/shadow-bom-deduction`, sees the sidebar
  link under Admin, summary cards and filters load without error.
- **Supervisor** — has no "Shadow BOM Deduction" sidebar entry, and a direct
  request to `GET /api/shadow-bom-deduction/summary` (or `/details`) returns
  `403`.
- **Branch Account** — same as Supervisor: no sidebar entry, `403` on both
  endpoints.

## 7. Enable one pilot branch

Set:
```
SHADOW_BOM_DEDUCTION_ENABLED=true
SHADOW_BOM_DEDUCTION_BRANCH_IDS=<pilot-branch-uuid>
```
and redeploy/restart the API. Only sales completed at the pilot branch after
this point will produce shadow comparisons; every other branch continues to
perform zero shadow work (no queries, no writes) because the branch gate is
checked before any shadow call is made.

## 8. Verify comparison rows are being produced

- Open `/admin/shadow-bom-deduction` as Super Admin, filter by the pilot
  branch, and confirm new rows appear as sales are rung up.
- Or query directly via the API:
  ```
  GET /api/shadow-bom-deduction/summary?branch_id=<pilot-branch-uuid>
  ```

## 9. Run the CLI reconciliation report

```
pnpm --filter @potato-corner/api exec tsx scripts/shadow-bom-deduction-report.ts
```
This prints total compared, match count/percentage, and a breakdown by
classification, and exits non-zero if there are any `ERROR`,
`UNIT_CONVERSION_UNSUPPORTED`, or `FLAVOR_DEPENDENCY` rows, or if the
eligible match percentage (excluding `BOM_NOT_READY`) is below 100% — useful
as a CI/cron gate ahead of widening the rollout.

## 10. Expand to several branches

Add more branch UUIDs to the comma-separated
`SHADOW_BOM_DEDUCTION_BRANCH_IDS` list and redeploy/restart. Review the
dashboard and CLI report after each expansion before adding more branches.

## 11. Enable all branches

Set `SHADOW_BOM_DEDUCTION_ENABLED=true` and clear
`SHADOW_BOM_DEDUCTION_BRANCH_IDS` (empty or unset) to run shadow comparisons
for every branch.

## 12. Rollback

Rolling back is always a config-only change, never a data change:

1. Set `SHADOW_BOM_DEDUCTION_ENABLED=false` (or remove specific branch ids
   from `SHADOW_BOM_DEDUCTION_BRANCH_IDS` to roll back only some branches).
2. Redeploy/restart the API if your environment requires a restart to pick
   up the new env value.
3. **Do not delete existing `ShadowBomComparison` rows** — comparison history
   remains available for later review even while the feature is disabled.
4. Legacy `ProductInventory` deduction continues to run unchanged throughout
   — rollback of this feature never touches the deduction path that actually
   affects inventory.
5. The `ShadowBomComparison` table and its migration may remain in place
   indefinitely; there is no requirement to reverse the CR-012.1 migration as
   part of a rollback of this phase.

## Manual acceptance checklist

Run through this after enabling the pilot branch (§7), before expanding
further:

- [ ] Super Admin can view `/admin/shadow-bom-deduction`: summary cards,
      filters (date range, branch, product variant, classification), and the
      paginated details table all load.
- [ ] Supervisor cannot access `/admin/shadow-bom-deduction` (no sidebar
      link) and gets `403` calling the API endpoints directly.
- [ ] Branch account cannot access `/admin/shadow-bom-deduction` (no sidebar
      link) and gets `403` calling the API endpoints directly.
- [ ] Complete one normal sale at the pilot branch — a new comparison row
      appears in the dashboard for that transaction/sale line, and the POS
      receipt/response is unaffected.
- [ ] Void or refund one transaction at the pilot branch — the original sale
      completes and displays normally; no duplicate or corrupted comparison
      row is created for the void/refund itself.
- [ ] No duplicate comparison row exists for any single sale line (the
      `transactionId` + `saleLineId` pair is unique per row — re-running the
      report or reloading the dashboard does not create duplicates).
- [ ] No duplicate inventory deduction occurred — `ProductInventory`/
      `InventoryStock` levels after the sale match what they would have been
      before this feature was enabled.
