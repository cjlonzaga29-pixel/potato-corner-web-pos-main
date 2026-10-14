# POS-PERF-P36R5 — Branch-Copy UI, Explicit Replacement, and Final Validation

**Status:** Implemented and verified locally (real-Postgres integration
tests, real HTTP requests against the booted Express app, a populated
pre-P36 migration replay, the full API/web suites). Not pushed, not
deployed, no production data, migrations, or Render config touched.
Starting HEAD `ec47a0403bfc5c330fa4499dfc0d6962f24c5cca` (9 commits ahead of
origin, clean tree) — see §7 for the final state.

## 1. What this session adds on top of P36R4

P36R4 (`docs/decisions/POS-PERF-P36R4-branch-isolation-authority-correction.md`)
shipped the backend fork-to-branch path (`POST /:productId/fork-to-branch`)
but explicitly deferred two things (§7 of that doc): a frontend affordance
for it, and an action to actually make a branch copy sellable in place of
its source. This session closes both:

1. **"Create Branch Copy" UI** — a supervisor who loads a shared product
   they only have partial branch authority over now sees a banner with a
   button, not just a read-only notice.
2. **`POST /:productId/replace-source`** — the explicit action that makes a
   branch copy the sellable product at its branch, disabling the source
   there and only there.
3. A real pre-existing authorization gap found while auditing nested/bulk
   write paths (§4) and fixed narrowly.
4. A populated-database replay of the exact P36/P36R4 migration set (§5).
5. Full-suite verification (§6).

## 2. "Create Branch Copy" workflow

`apps/web/app/(supervisor)/supervisor/products/[productId]/page.tsx`'s
existing read-only banner (flagged as a TODO by P36R4) now computes
`eligibleCopyBranches`: the actor's active branches intersected with every
branch this product is configured at (`branch_availability`, which already
carries a row per `BranchProductAvailability`, including temporarily-
unpublished ones — the same branch set `catalog-authority.ts`'s
`branchScopeFromProduct` uses, not just currently-sellable ones). The
"Create Branch Copy" button only appears when that intersection is
non-empty and the product is not already branch-exclusive — i.e. exactly
the population `hasActiveCatalogAuthority`'s full-coverage rule now locks
out of in-place edits.

`apps/web/components/admin/products/branch-copy-dialog.tsx`:
- One eligible branch: preselected, nothing to choose.
- More than one: a `<Select>` restricted to the eligible set only — never
  every branch the product sells at, never every branch the actor has
  access to, only the intersection.
- States plainly what's copied (product configuration, variants, recipes,
  flavor slots/option groups) and what isn't (stock balances, sales,
  movement history — those stay with the original).
- States that the copy starts as a draft, unsold anywhere, and that other
  branches selling the original are unaffected.
- On success, navigates straight into the product builder for the new
  (or existing) copy — `useForkProductToBranch` (`apps/web/hooks/queries/
  use-products.ts`) just calls the already-idempotent endpoint and routes to
  whatever product id comes back. A network failure/retry, or re-opening
  this dialog for a branch that already has a copy, hits the same
  idempotent server-side check (`forkProductForBranch`'s `findForkCopy`
  before create) and lands on the same existing copy — never a duplicate.

Authority, not creator ownership: eligibility is computed from the actor's
*live* branch assignments on every page load, not from who created the
product or who created the copy. Any supervisor currently assigned to the
copy's branch can open and edit it (proven in §3's integration tests); a
revoked/deactivated supervisor is denied the same way every other P36
mutation already is (`branchGuard` + `requireActiveSupervisor`, re-checked
on every request, never cached).

## 3. Explicit replacement — `replaceSharedProductAtBranch`

`apps/api/src/modules/products/products.service.ts`. `POST /:productId/
replace-source` (`:productId` is the **copy's** id; body carries
`branch_id`, which must equal the copy's own `exclusiveBranchId` — checked
by the service, not trusted from the body) is the one action that:

1. Validates the copy's own readiness at its branch first — the same gate
   `publishProduct` uses (`productReadinessService.evaluateProductReadiness`,
   `BRANCH_NOT_AVAILABLE` excluded since that's precisely the flag this
   flips). A not-ready copy is rejected with its blocking issues and
   **neither** row is touched.
2. Inside one transaction, holding both the source's and the copy's
   `productCatalogLockId` advisory locks (acquired in a fixed
   lexicographic order to rule out a deadlock against a concurrent
   replace/publish touching the same pair in the opposite order), flips the
   copy's `BranchProductAvailability` to available and the source's to
   unavailable at that one branch. A crash or thrown error between the two
   writes rolls back the whole transaction — cancellation/failure can never
   leave both or neither sellable.
3. Writes a `PRODUCT_REPLACED_AT_BRANCH` audit entry.

**Never inferred automatically.** Creating a copy, editing it, and
publishing it (plain `POST /:productId/publish`, unchanged) do not disable
the source — a copy existing, or even being sellable at its own branch
first via ordinary publish, is not replacement. Replacement is this one
dedicated endpoint, surfaced in the UI as a separate "Replace Source
Product" button (`apps/web/components/admin/products/replace-source-
dialog.tsx`) behind its own confirmation dialog, distinct from Publish.

**Historical sales/pending deductions are untouched by construction** — the
only write this action performs is to `BranchProductAvailability` rows; it
never touches `Product`, `ProductVariant`, `TransactionItem`,
`HoldOrderItem`, or `InventoryDeductionJob` rows, so every existing sale
keeps referencing the source's original id/variant ids and every pending
deduction job keeps resolving against them exactly as before.

**Existing carts referencing the source are already safe, with no new
code**: `transactions.service.ts`'s checkout path re-evaluates
sellable/readiness per cart line *at checkout time* (not from whatever the
cart was built against — `resolveCartItems`'s existing `BRANCH_NOT_AVAILABLE`
check, pre-existing since Phase 10/CR-008). A cart line added before
replacement, against the now-disabled source, fails checkout with
`PRODUCT_UNAVAILABLE` (422) instead of silently completing against disabled
availability. No change was needed to prove this — it's the same gate every
other "a product went unavailable between add-to-cart and checkout"
scenario already goes through.

**Removal/archive/restore interaction, documented explicitly**: `changeProductStatus`'s
archive/discontinue/restore cascades (`cascadeBranchAvailabilityOff`/`On`)
are untouched by this feature and operate on whichever product they're
called against. Archiving the **source** after replacement does not
re-enable it anywhere (its own cascade only ever turns availability off).
Restoring the source from `archived` to `active` **does** cascade
availability back on at every branch per existing Task-34 behavior — at a
branch where a copy has since replaced it, this would put both the
restored source and the copy's availability on simultaneously. This is the
same "restore re-publishes everywhere" behavior that already exists for
every other archive/restore cycle (not new to forked products); a
supervisor restoring a previously-discontinued source should treat it the
same as any other re-publish and verify branch availability afterward, same
as today. Not special-cased further this session — flagged here instead of
silently relying on it being obvious.

Integration tests (`apps/api/src/modules/products/
products.replace-source.integration.test.ts`, 7 tests, real Express +
Postgres):

| Case | Result |
|---|---|
| Replace-source on a product that isn't a fork-to-branch copy | `422 PRODUCT_NOT_A_BRANCH_COPY` |
| Replace-source while the copy is still draft/not-ready | `409 PRODUCT_NOT_READY`, neither row touched |
| `branch_id` the actor controls but isn't this copy's own branch | `422 BRANCH_MISMATCH` (service check, not just `branchGuard`) |
| `branch_id` the actor has no active assignment to | `403` (`branchGuard`) |
| Ready copy, correct branch | `200`; copy available, source unavailable at that branch, Branch B (if any) untouched, source identity/history untouched |
| Two concurrent replace-source requests for the same pair | both `200`, single consistent end state |
| Supervisor's branch assignment revoked before retry | `403` |

## 4. A real pre-existing authorization gap, found and fixed narrowly

While auditing "nested/bulk/upload endpoints use branch-team authority" per
this session's brief, `PATCH /:productId/branch-availability/bulk`
(`bulkUpdateBranchProductAvailability`) turned out to be **unreachable for
its only allowed caller**. Its body is `{ updates: [{ branch_id,
is_available }, ...] }`; the route's `branchGuard` middleware only ever
extracts a single top-level `branch_id` (`lib/request.ts`'s
`extractBranchId` checks `params`/`query`/`body.branch_id` — never an array
field), finds nothing, and 400s `BRANCH_ID_REQUIRED` for every supervisor
request before `bulkUpdateBranchProductAvailability` ever ran (super_admin
is skipped by `branchGuard` entirely, but POS-PERF-P35 already removed
super_admin's catalog write access — `supervisorOnly` is this route's only
allowed role). No frontend caller and no test existed for this route before
this session, which is how it went unnoticed.

**Fix**: `branchGuard` removed from the route; authorization moved into
`bulkUpdateBranchProductAvailability` itself, checking every `update.branch_id`
in the array against the actor's live branch access
(`hasBranchAccess`, the same query `branchGuard` uses) before any row is
touched — one denied `branch_id` fails the whole batch, not just its own
update. Proven by `apps/api/src/modules/products/
products.bulk-availability-authority.integration.test.ts` (2 tests): a
batch over branches the actor controls succeeds; a batch where one
`branch_id` is outside the actor's active assignments is rejected wholesale
and neither branch's row changes.

This is unrelated to branch-copy/fork logic specifically — it's a gap in
the branch-team-authority model this session's audit scope explicitly asked
about — fixed narrowly (middleware removed, service-level check added,
route behavior otherwise unchanged) rather than redesigned.

**Everything else audited and found already correct** (no new fix needed):
- Recipe→inventory mapping on a fork: `ProductComponent.inventoryItemId` is
  cloned unchanged; stock resolves by `(branchId, inventoryItemId)`
  independent of which `Product`/`ProductVariant` references it (unchanged
  architecture, confirmed again this session, not just carried over from
  P36R4's doc).
- Shared option groups/flavors: a fork clones the *assignment* row
  (`ProductVariantOptionGroup`/`ProductFlavorSlotSnackOption`) as a new row
  pointing at the same shared `OptionGroup`/flavor definition — editing or
  deleting the copy's assignment never touches the shared definition itself,
  because it's a distinct row with its own id.
- A supervisor's ability to edit a shared `OptionGroup`/`Category`
  definition directly (`hasSharedCatalogAuthority` — any active supervisor,
  by design, since those are branch-agnostic master data per CR-007 §3) is
  unrelated to and unaffected by owning a branch copy — it was already true
  for every active supervisor before this feature existed, not a privilege
  escalation introduced by forking.
- Invalid/cross-branch fork/replace references are rejected
  (`BRANCH_NOT_CONFIGURED_FOR_PRODUCT`, `BRANCH_MISMATCH`,
  `PRODUCT_ALREADY_BRANCH_EXCLUSIVE` — P36R4 and §3 above).
- Concurrent double-copy and double-replace are both idempotent (P36R4's
  existing test, §3 above respectively).

## 5. Populated migration-set validation

Addressed directly: verified the exact committed P36/P36R4 migration SQL
against a **fresh, populated, pre-P36 disposable database** — not the
already-fully-migrated `pos_verify` dev DB this session also used for
integration tests.

Procedure (local-only, `DIRECT_URL`'s target host/port verified as
`127.0.0.1:5432` before every step, per CLAUDE.md's three-URL rule):

1. Created a new disposable Postgres database, `pos_migration_check_p36r5`,
   on the same local server as `pos_verify`.
2. Built a temporary migrations directory containing every migration up to
   and including `20261013061526_pos_perf_p35r_catalog_management_assignment`
   (the commit immediately before P36R's `product_version` migration) —
   i.e. the real, pre-P36 migration set, not a hand-edited subset.
3. `prisma migrate deploy` against it: all 83 pre-P36 migrations applied
   cleanly from empty.
4. Generated a **separate Prisma Client from the pre-P36 schema** (git
   commit `31dc1e5`, the last commit before P36R) and used it to populate
   the database: an active branch, a supervisor with a live branch
   assignment, a unit of measure, an inventory item with on-hand stock, a
   product with a recipe/BOM (`ProductComponent`) mapping it to that stock,
   branch availability, a shift, a completed transaction with a line item
   (a sale), an audit-log entry, and a queued `InventoryDeductionJob`.
5. `prisma migrate deploy` again, this time against the real, current
   `prisma/migrations` directory (85 migrations) — applied exactly the two
   remaining migrations (`20261013185718_pos_perf_p36r_product_version`,
   `20261014214817_pos_perf_p36r4_product_fork_provenance`) cleanly on top
   of the populated pre-P36 data, with **no manual `--rolled-back` marking
   and no hand-written `migration.sql`** — addressing the P36R4-documented
   incident (`docs/decisions/POS-PERF-P36R4-...md` §4) where an earlier
   session's failed `migrate dev` attempt silently created an empty
   migration directory that then had to be caught and corrected by hand.
   This session's replay used only `migrate deploy` against the real,
   already-committed migration files — nothing empty, nothing hand-marked.
6. Verified with the **current** (post-migration) Prisma client: the seeded
   branch, product, recipe mapping, stock quantity, transaction, its line
   item, the audit log entry, and the queued deduction job all read back
   intact; `Product.version` backfilled to `1` and `forkedFromProductId`
   backfilled to `NULL` on the pre-existing product (both new, additive
   columns — no data loss). Also proved the new `@@unique([forkedFromProductId,
   exclusiveBranchId])` constraint directly: two rows both forked from the
   same product to the same branch collide (`P2002`); two rows with `NULL`
   `forkedFromProductId` coexist without colliding (Postgres NULL-distinct
   unique-index semantics, as P36R4's doc already described, now proven
   against a populated database rather than an empty one).
7. Dropped `pos_migration_check_p36r5` and removed the temporary migrations
   directory/generated client. `pos_verify` (the DB every other test in
   this session ran against) was never touched by this procedure —
   confirmed via `prisma migrate status` against it afterward
   (`Database schema is up to date!`, 85/85 migrations).

No production migration, data, or schema was touched; no already-applied
migration was rewritten.

## 6. Final validation

All run locally against `pos_verify` (verified `DATABASE_URL`/`DIRECT_URL`
host/port before anything, per CLAUDE.md), this session's HEAD:

| Check | Result |
|---|---|
| API full suite (`vitest run`, real Postgres, no exclusions) | **2875 passed, 227 skipped, 0 failed** (179 files, 164 passed / 15 skipped) |
| Web full suite (`vitest run`, no exclusions) | **1218 passed, 0 failed** (140 files, all passed) |
| API `tsc --noEmit` | clean |
| Web `tsc --noEmit` | clean |
| `@potato-corner/shared` build | clean |
| API `eslint` (changed files) | clean (pre-existing warnings/errors in unrelated files — `email.ts`, `fraud.queue.ts`, `server.ts` console-usage warnings; `transactions.builder-recipe-match.integration.test.ts` non-null-assertion errors — untouched this session, not newly introduced) |
| Web `eslint` (full repo) | 0 errors, 1 pre-existing warning (`two-factor-section.tsx`, `<img>` vs `next/image`, unrelated) |
| API production build (`tsc -p tsconfig.json`) | clean |
| Web production build (`next build`) | clean |

## 7. Files changed this session

- `apps/api/src/modules/products/products.service.ts` — `forked_from_product_id`
  exposed on the product response DTO; `replaceSharedProductAtBranch`;
  `bulkUpdateBranchProductAvailability`'s per-branch authorization fix.
- `apps/api/src/modules/products/products.router.ts` — `POST /:productId/
  replace-source`; `branchGuard` removed from the bulk-availability route.
- `apps/api/src/modules/products/products.replace-source.integration.test.ts` (new, 7 tests).
- `apps/api/src/modules/products/products.bulk-availability-authority.integration.test.ts` (new, 2 tests).
- `packages/shared/src/schemas/product.schema.ts` / `types/index.ts` —
  `replaceSourceWithCopySchema`/`ReplaceSourceWithCopyInput`;
  `forked_from_product_id` added to `productResponseSchema`.
- `apps/web/app/(supervisor)/supervisor/products/[productId]/page.tsx` —
  "Create Branch Copy" CTA in the read-only banner; "Replace Source
  Product" action in the Readiness & Publication card for a branch copy.
- `apps/web/components/admin/products/branch-copy-dialog.tsx` (new).
- `apps/web/components/admin/products/replace-source-dialog.tsx` (new).
- `apps/web/hooks/queries/use-products.ts` — `useForkProductToBranch`,
  `useReplaceSourceWithCopy`.
- `docs/decisions/POS-PERF-P36R5-branch-copy-ui-and-replacement.md` (this doc).

No production migration, product, upload, assignment, sale, billing, or
credential-rotation action was taken. No Render `autoDeploy` config was
touched. Not pushed, not deployed.

## 8. Remaining limitations / not covered in this pass

- **No browser/Playwright coverage.** Verification is real-Postgres
  integration + real HTTP against the booted Express app, and web/API unit
  suites — no actual browser was driven against the new dialogs this
  session. The UI was built directly against the same endpoints the
  integration tests exercise and follows this codebase's existing dialog
  patterns exactly, but "a real browser click-through" as asked for in the
  brief was not independently re-verified end-to-end through a rendered
  page.
- The restore-after-replace interaction (§3) is documented, not
  additionally gated — restoring an archived source still cascades
  availability on everywhere, same as it always has, which can put a
  restored source and its replacing copy both live at once. Flagged, not
  fixed, since it's pre-existing archive/restore behavior unrelated to the
  fork/replace feature itself.
- No production migration, catalog copy, upload, assignment, sale, or
  billing action was taken, and none of this was pushed or deployed.
