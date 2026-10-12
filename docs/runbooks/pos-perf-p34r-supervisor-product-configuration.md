# POS-PERF-P34R — Complete Supervisor Product Setup

## Starting / final state

- Starting local HEAD: `9b4ad728ff697e257d4dc4ca536539b324aef23d` (`fix(pos-perf-p34): move product creation to Supervisor`), 1 commit ahead of `origin/main`, clean working tree.
- Final local HEAD: see the commit this report ships alongside — 2 commits ahead of `origin/main` (unchanged remote; nothing pushed).
- Local stack used for verification: existing disposable local Postgres (`pos_verify` on `127.0.0.1:5432`, `DATABASE_URL`/`DIRECT_URL` verified before any write), local Supabase Storage (`127.0.0.1:54321`), `apps/api` (port 4000), `apps/web` (port 3000, both `next dev` and a full `next build` were exercised). No production connection string, data, uploads, sales, billing, or Render `autoDeploy` config was touched.

## Part 1 — The gap this closes

P34 opened product **creation** to Supervisor but left every downstream configuration step — variants/pricing, flavor links, option-group assignment, Recipe/BOM, and publish — `adminOnly`. A supervisor could create a product and then do nothing else with it; every subsequent step required an Admin, contradicting the goal of self-serve setup. Three latent issues surfaced during the audit, before any new code was written:

1. **Dead approval workflow.** `ProductVariant.lifecycleStatus` defaults to `ACTIVE` in the schema, and the DRAFT→PENDING_APPROVAL→ACTIVE approval service methods (`submitVariantForApproval`/`approveVariant`/`rejectVariant`/`editActiveVariant`/`archiveVariant`) are not wired to any router endpoint and not called from the frontend. They were left untouched (dead code, out of scope) — this is **not** a live governance gate.
2. **Creation auto-published.** `productsRepository.createWithCascade` seeded every `branch_product_availability` row with `isAvailable: true` at creation time — "a row exists" and "published and sellable" were conflated, contradicting `publishProduct`'s own doc comment, which assumes `BRANCH_NOT_AVAILABLE` is the normal pre-publish state.
3. **branch_exclusive had no ongoing enforcement.** It was read once at creation and never checked again — `publishProduct`/`updateBranchProductAvailability`/`changeProductStatus`'s branch path would happily enable a branch-exclusive product at any branch the actor has access to, for any role.

## Part 2 — The fix

### Ownership-scoped authorization (new)

Every nested product-configuration write a supervisor can now reach is scoped server-side to products **they created** (`product.createdBy === actor.id`), checked in the service layer (never just the router):

| Endpoint | Router guard (before → after) | Service-layer ownership check |
|---|---|---|
| `POST /products/:id/variants` | `adminOnly` → `adminOrSupervisor` | `products.service.ts#createVariant` |
| `PATCH /products/:id/variants/:vid` | `adminOnly` → `adminOrSupervisor` | `products.service.ts#updateVariant` |
| `DELETE /products/:id/variants/:vid` | `adminOnly` → `adminOrSupervisor` | `products.service.ts#deleteVariant` |
| `POST .../variants/:vid/flavors` | `adminOnly` → `adminOrSupervisor` | `flavors.service.ts#linkFlavorToVariant` |
| `PATCH .../variants/:vid/flavors/:fid` | `adminOnly` → `adminOrSupervisor` | `flavors.service.ts#updateVariantFlavor` |
| `POST .../variants/:vid/option-groups` | `adminOnly` → `adminOrSupervisor` | `product-options.service.ts#assignOptionGroupToVariant` |
| `PATCH .../variants/:vid/option-groups/:aid` | `adminOnly` → `adminOrSupervisor` | `product-options.service.ts#updateVariantOptionGroup` |
| `DELETE .../variants/:vid/option-groups/:aid` | `adminOnly` → `adminOrSupervisor` | `product-options.service.ts#unassignOptionGroupFromVariant` |
| `POST/PATCH/DELETE /product-components` | `adminOnly` → `adminOrSupervisor` | `product-components.service.ts#assertParentProductWritable` |
| `POST /products/:id/image` | already `adminOrSupervisor` (P34) | already ownership-scoped (P34) |

What stays **adminOnly** and was deliberately **not** opened: standalone Flavor create/edit (CR-010 already disabled), Option Group/Option catalog CRUD (`createGroup`/`updateGroup`/`deleteGroup`/`createOption`/`updateOption`), image delete, and base product `PATCH`/`DELETE`. A supervisor consumes existing reference data (flavors, option groups, inventory items) — they never gain the ability to create or edit it.

### Global catalog safety (fixed)

1. **`createWithCascade` seeds `isAvailable: false`**, not `true` (`products.repository.ts`). A `branch_product_availability` row existing is no longer conflated with "published." This applies to every product (Admin's too, not just Supervisor's) — `publishProduct`/`updateBranchProductAvailability` are now the only ways to actually go live anywhere, matching their own existing design intent.
2. **A supervisor may only create a branch-exclusive product.** `createProduct` now rejects `branch_exclusive: false` for a `SUPERVISOR` actor with `403 SUPERVISOR_EXCLUSIVE_BRANCH_REQUIRED` — a non-exclusive product cascades a catalog row to every active branch company-wide, which a supervisor must never trigger. super_admin is unrestricted (existing, broader capability preserved). `CreateProductDialog` (supervisor-only consumer) drops the Branch-Exclusive toggle entirely and always sends `branch_exclusive: true` with a required branch picker (already scoped to the supervisor's own branches via `GET /branches`' existing `getAccessibleBranchIds` filtering).
3. **`branch_exclusive` is now enforced on every enable action**, not just at creation (`assertSupervisorMayEnableAtBranch` in `products.service.ts`, applied in `updateBranchProductAvailability`, `bulkUpdateBranchProductAvailability`, and `changeProductStatus`'s branch-scoped path — `publishProduct` delegates to `updateBranchProductAvailability` so it's covered automatically). A supervisor can never enable a branch-exclusive product at any branch other than its own `exclusiveBranchId`, closing the gap in Part 1 item 3. super_admin is unrestricted.

### Frontend

- `/supervisor/products/[productId]` rebuilt from a read-only stub into a full configuration page, reusing existing admin components as-is (`VariantCard`, `VariantFormDialog`, `LinkFlavorDialog`, `EditVariantFlavorDialog`, `ReadinessChecklist`) — no new form logic was written.
- Added: an Overview-tab Product Image panel (upload/replace only — delete stays Admin-only, matching the backend posture) and explicit **Publish**/**Unpublish** buttons wired to the existing, previously-unused `usePublishProduct`/`useUnpublishProduct` hooks. Publish is disabled unless `readiness.sellable` is true — this is the actual go-live gate now, not the raw branch-availability toggle.
- Non-owner banner: if `product.created_by_user.id !== currentUser.id`, the page shows an amber notice and every configuration dialog is gated off (`canConfigure = isOwner && status !== 'archived'`), even though the buttons remain visible (server-side 403 is the real guarantee either way, consistent with the rest of the codebase's posture elsewhere).
- Fixed a latent frontend bug found during verification: `RecipeBomPanel`'s "Add/Edit/Remove Component" controls were gated by `isAdmin()` only — a holdover from before this task that silently blocked every supervisor from the Recipe/BOM UI even after the backend was opened. Changed to `isAdmin() || isSupervisor()`, matching the ownership-scoped-server-side pattern used everywhere else on this page.

## Part 3 — Final ownership / role matrix

| Action | Supervisor (own product) | Supervisor (another's product) | Super Admin |
|---|---|---|---|
| Create product | ✅ branch-exclusive only, scoped to own branches | n/a | ✅ unrestricted (any scope) |
| View product (any) | ✅ | ✅ read-only | ✅ |
| Edit name/description/category/seasonal | ❌ (unchanged, out of scope) | ❌ | ✅ |
| Add/edit/delete variant | ✅ | ❌ 403 | ✅ |
| Link/update flavor on variant | ✅ (existing flavors only) | ❌ 403 | ✅ |
| Assign/update/remove option group on variant | ✅ (existing groups only) | ❌ 403 | ✅ |
| Add/edit/delete Recipe/BOM component | ✅ | ❌ 403 | ✅ |
| Upload/replace product image | ✅ | ❌ 403 | ✅ |
| Delete product image | ❌ | ❌ | ✅ |
| Publish/unpublish at a branch | ✅ own `exclusiveBranchId` only | — (own product can't exist at another's branch) | ✅ any branch |
| Enable/toggle availability at a branch | ✅ own `exclusiveBranchId` only (any product, existing CR-003 operational scope) | ✅ same (operational, not ownership-scoped — unchanged) | ✅ |
| Create Flavor / Option Group / Option (catalog) | ❌ | ❌ | ✅ |
| Delete variant with transaction history | ❌ 409 (unchanged) | ❌ | ❌ 409 (unchanged) |

Branch/staff roles: unchanged — no creation or configuration access, per the existing posture this task did not touch.

## Part 4 — Global vs. branch publication behavior

- **Creation never publishes anything.** A new product's `branch_product_availability` row(s) are created `isAvailable: false`. The product is invisible in every POS catalog (`findCatalogForBranch` requires `status: 'active' AND isAvailable: true`) regardless of creation-time `status`.
- **Two independent gates must both pass** before a product is sellable at a branch: (1) `Product.status === 'active'` (global — only `super_admin` can transition this via `PATCH /products/:id/status`; this is the one step in the whole flow a supervisor cannot do themselves, by design — see Part 5), and (2) a readiness-passing `publishProduct` call at that specific branch (variant active + priced, Recipe/BOM configured, InventoryStock provisioned, flavor/Mix&Max consistency).
- **`publishProduct` is the only sanctioned way to flip branch availability to `true` for a `NOT_READY` product** — it's rejected with `409 PRODUCT_NOT_READY` and the exact blocking issues. The raw `PATCH .../branch-availability/:branchId` toggle still exists (used by `BranchAvailabilityPanel`, unchanged, Admin's day-to-day tool) and is **not** readiness-gated — the new supervisor page deliberately does not expose that raw toggle; it only exposes the readiness-gated Publish/Unpublish actions.
- **branch_exclusive is now a durable constraint**, not just a creation-time default: see Part 2 item 3.

## Part 5 — Limitations (by design, not oversight)

- **Product global activation (`draft` → `active`) remains Admin-only.** This was an explicit, pre-existing `GLOBAL_TRANSITIONS` rule this task was instructed to preserve ("Preserve established publication rules"). A supervisor completes every other step of setup unassisted; the final company-wide activation flip is the one deliberate Admin checkpoint left in the flow. (The dead DRAFT→PENDING_APPROVAL→ACTIVE **variant**-lifecycle approval gate described in Part 1 item 1 is not live and was not re-enabled — it would be a separate, larger change.)
- **`BranchAvailabilityPanel`'s raw per-branch toggle is unchanged** and still not readiness-gated — it is Admin's existing operational tool, out of scope to alter. The supervisor page does not use it; it uses `publishProduct`/`unpublishProduct` instead.
- **Supervisor branch-availability "operational" scope (CR-003) is intentionally broader than "owns the product."** A supervisor may flip availability for *any* product at a branch they manage (pre-existing day-to-day oversight capability) — only the *configuration* actions (variant/flavor/option-group/recipe/image writes) are ownership-scoped. `branch_exclusive` enforcement (Part 2 item 3) still prevents them from enabling a product outside its own exclusive branch, regardless of who created it.
- **This audit cannot see outside this repository** — no mobile app, no separate integration surface was found referencing these endpoints; none claimed as a guarantee beyond what's in this codebase.

## Part 6 — Deployment compatibility

- **Old frontend (pre-P34R) + new API**: variant/flavor/option-group/recipe POST/PATCH/DELETE for a supervisor now succeed where they'd have 403'd before — purely additive capability, no response-shape change, no breaking change for an old frontend that never attempted these calls as a supervisor.
- **New frontend + old API (mid-rollout)**: the new supervisor product page would hit the old `adminOnly` guards and surface 403s on every configuration action until the API side deploys — a safe failure mode (clear permission error, no data corruption), same posture as any additive-permission rollout.
- **Migration**: none. No schema change in this task.
- **Existing products**: `createWithCascade`'s `isAvailable: false` change only affects *new* product creation. Pre-existing `branch_product_availability` rows (any value) are untouched — no backfill, no reinterpretation. A product already live before this change stays exactly as available as it was.

## Part 7 — Verification (executed, not authored-only)

All of the following were driven against the real running local stack (real Chromium via Playwright, real Express API on :4000, real `next build`/`next dev` on :3000, real local Postgres `pos_verify`, real local Supabase Storage) — not substituted with component tests alone.

### Real browser (Playwright, supervisor `supervisor@potatocorner.test`)

1. Logged in, opened **Create Product**: branch-exclusive is now the only option, branch picker pre-scoped to the supervisor's own branch; created "P34R Verify Fries" as `draft`.
2. On the product detail page's **Variants, Flavors & Recipe** tab: added a variant (Regular, ₱65), linked an existing Flavor, assigned an existing Option Group, added a Recipe/BOM component (inventory item + auto-filled quantity/unit) — every action succeeded as the owning supervisor, each updating the Readiness panel live.
3. Readiness panel correctly listed blocking issues at each stage (`RECIPE_MISSING` before the BOM step; `PRODUCT_INACTIVE`/`BRANCH_NOT_AVAILABLE` throughout, since neither had happened yet) and the **Publish** button stayed disabled the whole time.
4. After an admin activated the product globally (`PATCH /products/:id/status {status:"active"}`) and the supervisor called `publishProduct` for their branch: reloaded the page — readiness showed **0 blocking issues, 100% complete, "Published at your branch,"** and an **Unpublish** button appeared. Screenshot captured.
5. Confirmed via `GET /products/catalog?branch_id=<branch>` (the same endpoint the POS terminal reads) that "P34R Verify Fries" is now present in the branch's live catalog.

### Real API, ownership/negative cases (13/13 passed, two independent supervisors + two branches seeded for this run only)

| Check | Result |
|---|---|
| Owner (supervisor1) can read their own product | ✅ 200 |
| supervisor2 cannot create/update/delete a variant on supervisor1's product | ✅ 403 ×3 |
| supervisor2 cannot link a flavor / update a flavor link on supervisor1's variant | ✅ 403 |
| supervisor2 cannot assign an option group on supervisor1's variant | ✅ 403 |
| supervisor2 cannot add a Recipe/BOM component on supervisor1's variant | ✅ 403 |
| supervisor2 cannot upload an image to supervisor1's product | ✅ 403 |
| supervisor1 (owner) CAN update their own variant | ✅ 200 |
| supervisor2 cannot publish supervisor1's branch-exclusive product to supervisor2's own branch | ✅ 403/409 (never 2xx) |
| supervisor2 cannot directly toggle supervisor1's branch-exclusive product available at supervisor2's branch | ✅ 403 `PRODUCT_BRANCH_EXCLUSIVE` |
| supervisor1 cannot create a non-exclusive (company-wide) product | ✅ 403 `SUPERVISOR_EXCLUSIVE_BRANCH_REQUIRED` |
| supervisor1 cannot create a product exclusive to a branch they don't manage | ✅ 403 `EXCLUSIVE_BRANCH_ACCESS_DENIED` |

### Regression suites

- **Backend typecheck** (`tsc --noEmit`, `apps/api`): clean, 0 errors.
- **Backend unit/router tests** (`vitest run`, full suite): all passing — the touched-module slice (`products`, `flavors`, `product-options`, `product-components`) is 163+ tests covering the new ownership checks, the new `SUPERVISOR_EXCLUSIVE_BRANCH_REQUIRED` rule, and the new `PRODUCT_BRANCH_EXCLUSIVE` guard (2 new tests added).
- **Frontend typecheck** (`tsc --noEmit`, `apps/web`): clean, 0 errors.
- **Frontend unit tests**: `create-product-dialog.test.tsx` (branch-required flow, rewritten), `recipe-bom-panel.test.tsx` (supervisor-write-access tests replacing the stale supervisor-read-only assertions) — all passing.
- **Frontend production build** (`next build`): 75/75 pages generated successfully, including the new `/supervisor/products/[productId]` route and the modified `CreateProductDialog`.
- **Lint** (`eslint` on every changed file, both packages): 0 errors.

## Part 8 — Release / rollback

- **Release**: this commit alone; no migration, no environment variable changes, no Render `autoDeploy` changes.
- **Rollback**: revert this commit. No schema or data shape changed — a revert is a plain code rollback with zero data-loss risk. Any product created or published during this change's lifetime keeps working under the old (P34) rules after rollback; the only behavior that reverts is that new products would once again seed `isAvailable: true` at creation and non-exclusive supervisor creation would once again be possible.
