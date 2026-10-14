# POS-PERF-P36R3 — Final Publication and Branch-Scope Verification

**Status:** Implemented and verified locally (real-Postgres integration tests,
real concurrent-Postgres races). Not pushed, not deployed, no production
data, migrations, or Render config touched. See §6 for exact SHAs and §7 for
what remains open.

This phase closes the two items `docs/decisions/POS-PERF-P36R2-recovery-and-
release-verification.md` §7 explicitly flagged as not yet proven: the flavor-
slot-vs-publish race (an analog of the proven component-delete race) and a
direct audit of `branchGuardOptional`'s scope. It also reviews option-group
assignment's concurrency guarantees against real Postgres rather than by
inspection, per this session's task instructions.

## 1. Publication-lock coverage completed: flavor-slot / snack-option CRUD

`productCatalogLockId`'s own doc comment (`apps/api/src/lib/pg-lock.ts`)
already claimed to cover "every ProductComponent/flavor-slot mutation that
can invalidate readiness," but P36R2 §7 recorded that the flavor-slot side
was never actually implemented — `performSlotEditWithActiveGovernance`
(`apps/api/src/modules/products/products.service.ts`, the single chokepoint
behind `addFlavorSlot`/`updateFlavorSlot`/`removeFlavorSlot`/
`reorderFlavorSlots`/`addSnackOption`/`removeSnackOption`) took no lock at
all. A required `ProductFlavorSlot`'s readiness (`MIX_MAX_SLOT_INCOMPLETE`,
`product-readiness.service.ts`) depends on it having at least one active
snack option with its own valid Recipe/BOM — exactly the kind of
readiness-invalidating mutation `publishProduct`'s lock exists to serialize
against.

**Fixed**: `performSlotEditWithActiveGovernance` now takes
`productCatalogLockId(variant.productId)` before reading/writing, on both of
its branches:
- The ACTIVE-variant branch (already inside `prisma.$transaction` for its
  version-bump + ChangeLog write) — lock acquired first, before
  `listVariantFlavorSlots`'s before-snapshot read.
- The DRAFT/PENDING_APPROVAL branch, which previously ran the mutation
  directly against `prisma` with **no transaction at all** — now wrapped in
  its own `prisma.$transaction` so the lock can be taken. This is a
  behavioral tightening (multi-statement slot mutations are now atomic),
  not a narrowing of what's permitted.

No mutation callback (`addFlavorSlot` etc.) needed its own change — they
already accepted a `tx: Prisma.TransactionClient | typeof prisma` parameter
and used it for every repository call, so threading the real transaction
client through was free.

**Proven with two deterministic real-Postgres races**
(`apps/api/src/modules/products/products.publish-safety.integration.test.ts`),
covering both operation orders, using the same lock-hold technique as
P36R2's component-delete proof (one side manually takes the advisory lock
and holds it open on purpose, synchronized via a gate promise):

| Order | Result |
|---|---|
| `removeSnackOption` (removing a required slot's last snack option) wins the lock first | `publishProduct` blocks, then correctly rejects `409 PRODUCT_NOT_READY` once unblocked — it never commits against a snapshot the removal has already invalidated. |
| `publishProduct` wins the lock first | It commits against the configuration that existed at read time (`BranchProductAvailability.isAvailable: true`); the blocked `removeSnackOption` is released only afterward and is permitted to proceed (not blocked outright). |

### 1a. Established policy confirmed, not changed: a permitted post-publish edit does not force an unpublish

The second race above leaves a published product whose required slot is now
incomplete. This is **not** a gap — `productReadinessService` /
`transactions.service.ts`'s checkout path (`readinessRejection`,
`READINESS_TRANSACTION_ERRORS`) independently re-evaluates readiness fresh
on every sale, the same way it already does for Recipe/BOM deletes
post-publish (P36R2 §3's `deleteMapping`/`updateMapping`, which also never
auto-unpublish). `MIX_MAX_SLOT_INCOMPLETE` is already wired into that
checkout-time rejection table. "Invalid configuration cannot remain
sellable" is satisfied by checkout's own fresh check, not by forcing publish
to retroactively flip availability — confirmed directly in the second race
test above (`readiness.blockingIssues` contains `MIX_MAX_SLOT_INCOMPLETE`
after the permitted edit, while `BranchProductAvailability.isAvailable`
stays `true`).

## 2. Archive/restore branch authorization — `branchGuardOptional` audited, no gap found; test coverage completed

Re-read `branchGuardOptional` (`apps/api/src/middleware/branch-guard.ts`),
`extractBranchId` (`apps/api/src/lib/request.ts`), `hasBranchAccess`/
`getAccessibleBranchIds` (`apps/api/src/lib/branch-access.ts`),
`findAllActiveBranchIds` (`branches.repository.ts`), and
`hasActiveCatalogAuthorityForProduct`/`hasActiveCatalogAuthority`
(`apps/api/src/lib/catalog-authority.ts`) end to end. No bypass exists:

- `branchGuardOptional` only ever **defers** the decision when `branch_id`
  is absent — it never grants authority itself. The actual gate for the
  no-`branch_id` (global lifecycle) path is `changeProductStatus`'s own
  `hasActiveCatalogAuthorityForProduct` check, which re-reads the
  supervisor's **active** branch assignments from Postgres on every call
  (`removedAt: null`, `branch.status: 'active'`) — never the JWT's
  `branch_ids` claim.
- `changeProductStatusSchema`'s `branch_id: z.uuid().optional()` rejects a
  non-string/nested `branch_id` (array, object) with `422` before
  `branchGuardOptional` or the service ever sees it — `extractBranchId`
  additionally only ever returns a value when `typeof candidate ===
  'string'`, so even if validation were bypassed, a nested value cannot be
  coerced into "absent, therefore global."
- **Superseded by `docs/decisions/POS-PERF-P36R4-branch-isolation-authority-
  correction.md`**: the paragraph below described a *shared* (non-exclusive)
  product's global authority as "any active-branch intersection with the
  product's current selling branches grants authority over the *whole*
  product, by design." That contradicted the actually-approved requirement
  ("supervisor authority follows assigned branches, and editing Branch A
  must not change Branch B") — a supervisor assigned to only one of a
  shared product's branches could edit Product/ProductVariant/
  ProductComponent/ProductFlavorSlot/ProductVariantOptionGroup rows that are
  global across every branch selling it, silently changing branches they
  had no assignment to. POS-PERF-P36R4 corrected
  `hasActiveCatalogAuthority` to require the actor's active branches be a
  **superset** of every branch the product is configured at (not mere
  overlap), and added a scoped fork-to-branch path for a supervisor who
  controls only some of them. What was and still is correctly rejected: a
  supervisor with **zero** overlap at all — preserved below, now also true
  of a supervisor with partial (but not full) overlap.

**New test coverage** (`apps/api/src/modules/products/products.status-branch-
guard.integration.test.ts`, extending P36R2's existing 2 tests to 7, all
booting the real Express app + Postgres):

| Case | Result |
|---|---|
| Assigned supervisor archives their own branch-exclusive product, no `branch_id` | `200` (P36R2, unchanged) |
| Branch-scoped change naming a branch the supervisor lacks access to | `403` (P36R2, unchanged) |
| Global change (no `branch_id`) on a *shared* product the supervisor has **zero** active-branch overlap with | `403` — `hasActiveCatalogAuthorityForProduct` correctly finds no coverage; product status unchanged. (POS-PERF-P36R4: a supervisor with **partial** overlap is now also `403` here — see that doc.) |
| Branch-scoped change naming a syntactically-valid but nonexistent `branch_id` (forged) | `403` — never appears in `findAllActiveBranchIds` |
| `branch_id` submitted as a nested object | `422` — Zod validation, never reaches `branchGuardOptional` |
| Branch-scoped change after the supervisor's assignment to that branch is revoked (`removedAt` set) | `403` |
| Any status change once the supervisor account itself is deactivated | not `200` — `requireActiveSupervisor` (already on this route, ahead of `branchGuardOptional`) |

## 3. Option-group assignment conflict behavior — reviewed, two narrow HTTP-response gaps found and fixed; no version field added

Per this session's explicit instruction, reviewed `ProductVariantOptionGroup`
assign/update/unassign (`apps/api/src/modules/product-options/product-
options.service.ts`) without assuming the absence of `expected_version`
is itself a defect — it carries no `version` column, and none was added.

`@@unique([productVariantId, optionGroupId])` (schema.prisma) already makes
a duplicate assignment impossible at the database level regardless of race
timing, and readiness/checkout never evaluates option-group completeness at
all (no `REQUIRED_OPTION_INCOMPLETE`-shaped check exists in
`product-readiness.service.ts`) — option selections are instead re-validated
fresh at sale time (`transactions.service.ts`'s `resolveSelectedOptions`,
which reads the variant's current `optionGroupAssignments` and rejects a
since-removed/disallowed option with `422 PRODUCT_OPTION_NOT_AVAILABLE`),
the same checkout-re-check pattern as §1a above. So the data was never at
risk of silent corruption or a stale required choice staying sellable.

**What real-Postgres races did find** (new file
`apps/api/src/modules/product-options/product-options.concurrency.
integration.test.ts`, 3 tests): the existing constraint/not-found conditions
were correctly stopping the invalid state at the database layer, but the
raw `PrismaClientKnownRequestError` (`P2002` for a concurrent duplicate
assign, `P2025` for an update/unassign racing a concurrent unassign of the
same row) is not a `ProductOptionError`, so it fell through `handleModuleError`
's `next(error)` to `app.ts`'s generic error handler — an opaque `500
"Something went wrong"` instead of this exact route's own already-defined
actionable error for the identical case (`409
VARIANT_OPTION_GROUP_ALREADY_ASSIGNED` / `404
VARIANT_OPTION_GROUP_NOT_FOUND`).

**Fixed**: `assignOptionGroupToVariant`, `updateVariantOptionGroup`, and
`unassignOptionGroupFromVariant` each now catch
`Prisma.PrismaClientKnownRequestError` with the specific code the existing
constraint produces and re-throw the pre-existing `ProductOptionError` for
that exact case — reusing the database constraint as the source of truth
instead of adding a lock, a version column, or new business logic.

| Race (`Promise.allSettled`, not sequential) | Before | After |
|---|---|---|
| Two concurrent assigns of the same group to the same variant | 1 succeeds, 1 raw `P2002` → `500` | 1 succeeds, 1 → `409 VARIANT_OPTION_GROUP_ALREADY_ASSIGNED` |
| Two concurrent unassigns of the same assignment | 1 succeeds, 1 raw `P2025` → `500` | 1 succeeds, 1 → `404 VARIANT_OPTION_GROUP_NOT_FOUND` |
| An update racing a concurrent unassign of the same assignment | update either succeeds or raw `P2025` → `500` | update either succeeds or → `404 VARIANT_OPTION_GROUP_NOT_FOUND`; unassign (no precondition of its own) always succeeds |

## 4. Migration evidence — scope note, not re-run

P36R2 §4's populated pre-P36 → `4985ef1` migration test already documents
its own scope accurately: it proves the `inventoryDeductionService.runCycle`
worker's claim/complete **lifecycle** survives the schema upgrade
(`claimed:1, completed:1, failed:0` against a pre-existing `pending` job),
not the ingredient-quantity **arithmetic** — P36R2 §4 says so explicitly
("a property of this test's seed data, not a migration defect") and §7
already points at the test that proves the math:
`apps/api/src/modules/transactions/transactions.builder-recipe-match.
integration.test.ts` (confirmed still present, unmodified). This session
made no changes to the deduction worker, the checkout path, or any
migration — `apps/api/prisma/migrations/` has no new files in this diff —
so neither the migration rehearsal nor the builder-recipe-match arithmetic
test needed to be re-run; both remain valid as last executed under P36R2.

## 5. Final validation

| Check | Result |
|---|---|
| `apps/api` full `vitest run` (`TEST_DATABASE_URL`/`DATABASE_URL` set to local disposable `pos_verify` Postgres, via the `potato-corner-pos-postgres-1` Docker container) | **2,979 passed, 0 failed, 99 skipped** (3,078 total) |
| `apps/api` `tsc --noEmit` | clean |
| `apps/api` `tsc -p tsconfig.json` (build) | clean |
| `apps/api` `eslint` on touched files | clean |
| `apps/web` `tsc --noEmit` | clean |

`apps/web` and `packages/shared` had **zero source changes** this session
(`git status` confirms every modified/new file is under `apps/api`) — their
full test suites and `next build` were not re-run, since nothing in this
diff could affect them; `apps/web`'s typecheck was still run as a cheap
cross-check and came back clean.

## 6. Validation / SHAs

Starting HEAD: `5bb1a0f4e842ea457e23cfa6186e38ee8fe67e98` (matches the
expected starting commit; working tree was clean before this session).

Files changed this session:
- `apps/api/src/modules/products/products.service.ts` —
  `performSlotEditWithActiveGovernance` takes `productCatalogLockId` on both
  branches; the DRAFT/PENDING_APPROVAL branch is now wrapped in its own
  `prisma.$transaction`.
- `apps/api/src/modules/products/products.publish-safety.integration.test.ts`
  — two new deterministic real-Postgres races (§1), both operation orders.
- `apps/api/src/modules/products/products.status-branch-guard.integration.test.ts`
  — five new HTTP-level authorization tests (§2).
- `apps/api/src/modules/product-options/product-options.service.ts` —
  `assignOptionGroupToVariant`/`updateVariantOptionGroup`/
  `unassignOptionGroupFromVariant` translate `P2002`/`P2025` into the
  existing `ProductOptionError` codes.
- `apps/api/src/modules/product-options/product-options.concurrency.
  integration.test.ts` (new) — three real-Postgres races proving §3's fix.
- `apps/api/src/modules/products/products.service.test.ts` — five
  assertions updated from the old call shape (bare `prisma`) to the new one
  (`txMock`, the test file's existing transaction-client stand-in) for the
  DRAFT/PENDING_APPROVAL flavor-slot path, consistent with the lock fix.

## 7. Remaining limitations / not covered in this pass

- Option-group assignment's lack of `expected_version` is confirmed correct
  to leave as-is (per this session's own instruction and P36R's prior
  reasoning): no proven data-integrity gap, only an HTTP-response gap, which
  is now fixed.
- No production migration, product, upload, assignment, sale, billing, or
  credential-rotation action was taken. No Render `autoDeploy` config was
  touched. Not pushed, not deployed.
- Local Postgres continues to accumulate leftover test branches/rows across
  sessions (P36R2 §7 already noted this) — harmless for a disposable local
  DB, out of scope here, not cleaned up.

## 8. Rollback

Every change is additive (new lock-acquisition call, new error-translation
`catch` blocks, new test files) or a narrow correctness fix to an existing
code path (flavor-slot governance's transaction shape, three option-group
service methods' error handling). Rollback = revert the relevant file(s); no
schema change, no production data, migrations, catalog copies, assignments,
uploads, or sales were touched.
