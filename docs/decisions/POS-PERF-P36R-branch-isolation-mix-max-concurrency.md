# POS-PERF-P36R — Branch Isolation Proof, Mix & Max Builder Support, Edit Concurrency

**Status:** Implemented locally and verified (unit, real-Postgres integration,
and real-browser Playwright). Not pushed, not deployed, no production data
touched. See §6 for exact starting/final SHAs and §7 for what remains open.

This phase follows up on `docs/decisions/POS-PERF-P36-branch-catalog-and-
builder.md`, which shipped branch-team authority and the Simple Product
Builder but explicitly deferred three things: demonstrating the branch-
isolation claim with tests rather than just an audit, exposing the Mix & Max
slot editor in the builder, and closing the Product-level concurrency gap.
It also never ran a real browser against the builder end to end — doing so
in this phase surfaced three genuine, previously-undiscovered defects (§3)
that no amount of code review would have caught, because each only manifests
when a supervisor actually drives the wizard.

## 1. Branch isolation — proven, one real gap found and fixed

P36 §2 audited the schema and concluded isolation was already correct. This
phase proves that conclusion with a real-Postgres integration test
(`apps/api/src/modules/products/products.branch-isolation.integration.test.ts`,
8 tests, all passing) that actually exercises it: two branches, two
supervisors, one shared `InventoryItem`/`ProductCategory`/`UnitOfMeasure`.

Verified:
- A supervisor manages their own branch's product regardless of who created
  it; the other branch's supervisor is denied (403) on the exact same
  product, both directions.
- Both supervisors can map the *same* shared `InventoryItem` into their own
  recipe/BOM without any manual Catalog Assignment step.
- Editing the shared `ProductCategory` needs no per-branch grant (branch-
  agnostic master data, by design).
- A stock adjustment on Branch A for a shared item never touches Branch B's
  balance or movement history for that same item.

**Gap found and fixed**: `performSlotEditWithActiveGovernance`
(`products.service.ts`, CR-005) blocked *every* supervisor from editing
flavor slots once a variant's `lifecycleStatus` was `ACTIVE` — only
`super_admin` could. Since a freshly created `ProductVariant` defaults to
`ACTIVE` (see §3.2), this meant no supervisor could ever reach the Mix & Max
editor through the builder, in any branch, for any product — a stricter
failure than "unreachable," closer to impossible. Fixed to extend the same
branch-authority check every other P36 mutation already uses: a supervisor
with active branch authority over the product may edit, still gated on the
same mandatory reason as `super_admin`. Proven with both a unit test
(`products.service.test.ts`) and the browser pass in §3.

## 2. Mix & Max builder support

**The actual gap was bigger than the P36 doc's "not yet exposed in the UI"
description.** `ProductFlavorSlot`/`ProductFlavorSlotSnackOption` CRUD
existed in `products.service.ts` (CR-005 Sub-phase 3d) but had **no HTTP
route at all** — not reachable from any UI, and not reachable "directly via
API" either, since there was no endpoint to call.

Added:
- Routes on `products.router.ts`: `GET/POST /variants/:id/flavor-slots`,
  `PATCH/DELETE /flavor-slots/:slotId`, `POST /flavor-slots/reorder`,
  `POST/DELETE /flavor-slots/:slotId/snack-options/:optionId` — all
  supervisor-write / admin-or-supervisor-read, reusing the existing
  `performSlotEditWithActiveGovernance` machinery.
- Service: `addSnackOption`/`removeSnackOption` (new — `ProductFlavorSlotSnackOption`
  had read support via `getPosCatalog` but no write path at all) plus a
  `toFlavorSlotResponse` formatter. Snapshot comparison for the ACTIVE-variant
  no-op guard was extended to include snack-option membership (it previously
  only compared slot fields, so adding/removing a snack option on an ACTIVE
  variant would have been wrongly rejected as "no changes").
- Shared schemas: `addFlavorSlotSchema`, `updateFlavorSlotSchema`,
  `reorderFlavorSlotsSchema`, `addSnackOptionSchema`, `flavorSlotResponseSchema`
  (`packages/shared/src/schemas/product.schema.ts`).
- Web: `FlavorSlotPanel` + `FlavorSlotFormDialog` + `SnackOptionFormDialog`
  (`apps/web/components/admin/products/`), wired into the builder's existing
  Choices step (`ChoicesForVariant`) below the option-group UI — reused the
  same dialog/panel conventions as `RecipeBomPanel`/`AssignOptionGroupDialog`
  rather than inventing new patterns.

Mix & Max is not unreachable and was not converted to a simple product: the
existing `ProductFlavorSlot`/`SnackOption` data model, deduction path
(`transactions.service.ts`'s `computeComponentDeductionForSlots`), and POS
terminal slot-selection UI were all untouched and are exercised end to end in
§3's browser test.

## 3. Real-browser verification — three defects found and fixed

Ran against the local disposable stack (`pos_verify` Postgres on `:5432` +
`apps/api` dev server on `:4000` + `apps/web` dev server on `:3000`, all
local, per CLAUDE.md's three-URL rule — verified host/port before every
`prisma migrate` call). New spec:
`tests/e2e/pos-perf-p36r-branch-and-builder.spec.ts`, 2 tests, both passing,
confirmed stable on a repeat run.

**Test 1** drives the full path a supervisor actually experiences: log in →
builder (Details → Sizes & Prices → Ingredients & Packaging, adding an
inventory-backed packaging component → Choices, adding a flavor slot *and* a
snack option through the new UI → Review → Add to POS) → log out → log in as
staff → clock in (with mocked geolocation) → tap the product → the POS
terminal's existing slot-selection modal → pick the snack + its flavor → Add
to Cart → Checkout → Charge (real cash sale, real `POST /api/transactions`,
201). Confirmed via direct Postgres read that both the snack's own
ingredient and the Mix & Max parent's own packaging component decremented by
exactly 1 each after the sale — the real inventory-deduction worker, not a
mock. **Test 2** confirms a second branch's supervisor can neither see the
product in their list nor `PATCH` it directly (403), closing the loop with
§1's integration-level proof using the UI itself.

Driving this in a real browser — not just reading the code — surfaced three
defects that static review would not have caught, because each only shows
up once a supervisor actually clicks through the flow:

1. **Flavor-slot governance locked out every supervisor** — §1's fix.
2. **The builder created every product with `status: 'draft'` permanently.**
   `productReadinessService`'s `PRODUCT_INACTIVE` check is an unconditional
   publish blocker, and nothing in the builder — or anywhere else — ever
   promoted a product's `status` to `active`. A product built through the
   wizard could *never* reach "Add to POS," for any variant type, Mix & Max
   or simple. Fixed: the builder now creates with `status: 'active'` from
   Step 1 — "not yet published" is already fully represented by
   `BranchProductAvailability.isAvailable` staying `false` until Review.
3. **The Publish/"Add to POS" button could never become enabled on a first
   publish**, at *both* the builder and the supervisor's product detail
   page. Both gated on `readiness.sellable`, which is `blockingIssues.length
   === 0` — but `BRANCH_NOT_AVAILABLE` is always one of those blocking
   issues before a product is published, and it is the *one* issue
   `publishProduct` itself excludes from its own gate (by design — it's what
   publish resolves). The UI's gate didn't match the backend's gate, so the
   button was permanently disabled for any product that had never been
   published yet — which, since P34R forces every supervisor-created product
   to be branch-exclusive, is every single one. Fixed with a shared
   `isReadyToPublish()` helper (`apps/web/hooks/queries/use-products.ts`)
   that mirrors `publishProduct`'s exact exclusion, used at both call sites.

**Not run in this pass** (see §7): inline inventory creation inside the
builder (exists from P36, not independently re-verified here), Save
Draft/reload recovery, upload/network-failure retry, edit/archive/delete
restrictions, and branch-switching cache staleness. The scenarios this phase
specifically needed to prove — branch isolation, Mix & Max reachability,
and checkout/deduction — are covered above; a follow-up session should add
the rest, following this spec as a structural reference.

## 4. Concurrent edit safety

P36 §5 flagged a known gap: `ProductVariant.version`/`expected_version` existed,
but Product-level fields (name/description/category/display_order/seasonal
window) had none, so two supervisors editing the same product concurrently
could silently clobber each other. Separately, `ProductComponent` already had
a `version` column (bumped on every update) that nothing ever checked.

- **Migration** (additive, applied to the local `pos_verify` Postgres only —
  `apps/api/prisma/migrations/20261013185718_pos_perf_p36r_product_version/`):
  `products.version INTEGER NOT NULL DEFAULT 1`.
- `updateProductSchema` gained an optional `expected_version`; `updateProduct`
  rejects a mismatch with `409 PRODUCT_CONFLICT` and a plain-language "reload
  and retry" message, otherwise bumps `version` in the same update. Same
  backward-compatible posture as `updateVariantSchema`'s existing
  `expected_version`: omitted = no check.
- `updateProductComponentSchema` gained the same optional `expected_version`,
  checked against the mapping's existing `version` column in
  `product-components.service.ts`'s `updateMapping` → `409 MAPPING_CONFLICT`.
- Web: `EditProductDialog` and `RecipeComponentFormDialog` now send
  `expected_version` on edit. A rejected mutation never calls
  `onOpenChange(false)` (the existing pattern `VariantFormDialog` already
  used for `VARIANT_CONFLICT`), so a stale form's draft is never lost — the
  dialog stays open with everything the user typed, and the error toast
  tells them to reload.
- Proven with a real-Postgres integration test
  (`products.concurrency.integration.test.ts`): a stale `expected_version`
  is rejected and never overwrites the newer row; omitting it stays backward
  compatible.

Variant-level, recipe/BOM-level, and now Product-level fields all have
optimistic concurrency with the same shape. Option-group assignment
(`ProductVariantOptionGroup`) and publish/unpublish were reviewed and left
out of scope: publish/unpublish toggles one boolean per branch and is already
idempotent (no "stale read" to protect against), and option-group assignment
has no analogous multi-field edit race today — flagged for a future pass if
that changes.

## 5. Compatibility

- Checkout, inventory deduction, PWD/Senior VAT, transaction-number, and JWT
  structure: untouched.
- Legacy `ProductInventory`/`Flavor.ingredientName` deduction path and
  `isCatalogManager`/`effectiveCatalogManager` provenance display: untouched.
- `CatalogManagementAssignment` audit trail: untouched.
- Every `expected_version` field is optional and additive — no existing
  caller that omits it changes behavior.

## 6. Validation

Starting HEAD: `31dc1e5db622202fce63f1c1defdfcb9007f655d` (5 commits ahead of
the last reported production baseline `9f87159640dfdc18b3a9534140a2c585181df408`).

| Check | Result |
|---|---|
| `apps/api` full `vitest run` (real Postgres, no live dev server attached) | **2,960 passed, 0 failed, 99 skipped** (skips are pre-existing: a Redis-gated legacy integration suite from before Phase 21's Redis removal, and env-gated suites) |
| `apps/web` full `vitest run` | **1,218 passed, 0 failed, 0 skipped** |
| New Playwright spec (`pos-perf-p36r-branch-and-builder.spec.ts`) | **2/2 passed**, confirmed stable on repeat run |
| `apps/api` / `apps/web` / `packages/shared` `tsc --noEmit` | clean |
| `apps/api` / `apps/web` `eslint` on touched files | clean (repo-wide `eslint .` on `apps/api` has 12 pre-existing errors and ~300 pre-existing warnings, all in files this phase never touched — confirmed via `git diff --stat`) |
| `apps/api` build (`tsc -p tsconfig.json`) | clean |
| `apps/web` build (`next build`) | clean — full route manifest generated |

**Known environmental hazard, not a code defect** (same one P36 documented):
two transaction-integration tests gave false failures on a first combined
run because this session's own `apps/api` dev server was still attached to
the same local database, racing its background inventory-deduction poller
against the tests' own manual `runCycle()` calls. Stopping the dev servers
before the run made both pass cleanly and reproducibly.

## 7. Remaining limitations / not covered in this pass

- Browser scenarios not driven in this pass: inline inventory creation,
  Save Draft → reload → recovery, image-upload network-failure retry,
  edit/remove-from-POS/archive/delete restrictions, cross-branch denial of
  non-product resources (categories/units/inventory items — covered at the
  integration level in §1, not re-driven in a browser), and branch-switching
  cache staleness on the POS terminal.
- Option-group assignment and publish/unpublish have no `expected_version`
  (see §4's reasoning for why that's not currently a gap).
- The flavor-slot reorder endpoint (`POST .../flavor-slots/reorder`) has no
  dedicated UI yet — the panel always inserts at the end; reordering would
  need drag-and-drop or similar, out of scope for this pass.

## 8. Rollback

Every change is additive (new routes/schemas/columns/UI) or a narrow
authority/gating fix (flavor-slot governance, builder's initial `status`,
`isReadyToPublish`). Rollback = revert the relevant file(s); the
`products.version` column can stay (nothing breaks if `expected_version` is
simply never sent) or be dropped with a follow-up migration if truly
unwanted. No production data, migrations, catalog copies, assignments,
uploads, or sales were touched — verification ran entirely against a local
disposable Postgres.
