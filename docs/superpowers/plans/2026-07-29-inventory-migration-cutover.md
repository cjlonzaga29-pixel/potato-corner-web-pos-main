# Complete Inventory Migration (ProductInventory/Ingredient → ProductComponent/InventoryItem/InventoryStock) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ProductComponent` + `InventoryItem` + `InventoryStock` the single authoritative inventory architecture for readiness, publish validation, the Variant Card UI, and POS checkout deduction — retiring `ProductInventory`/`Ingredient` as live-path dependencies.

**Architecture:** The new model already exists end-to-end (schema, CRUD, backfill, shadow-mode comparison — see CR-006/007/008/010A/011/012 in `docs/decisions/CR-007-universal-inventory-domain-finalization.md` §20). Nothing here is a redesign: every phase below extends an existing, already-shipped module. The work is sequenced so each phase is independently shippable and the highest-risk phase (checkout deduction) only flips traffic after the existing `ShadowBomComparison` mechanism has validated it in production, per-branch, using the rollout pattern the codebase already uses for `SHADOW_BOM_DEDUCTION_ENABLED`.

**Tech Stack:** Node/TypeScript, Prisma/PostgreSQL, Express routers, React/Next.js (App Router), React Query, Vitest.

## Global Constraints

- Do NOT redesign Product Management, POS, Recipe/BOM, or Universal Inventory — every change here extends an existing module's existing pattern.
- `ProductComponent` has no flavor scoping today (schema comment, `schema.prisma:1206-1212`) — this is a real, explicit prerequisite gap, not an oversight to work around. Phase 2 closes it with an additive nullable column, mirroring `ProductInventory.flavorId`.
- Every checkout-deduction change must be feature-flagged and rolled out per-branch using the existing allowlist pattern (`SHADOW_BOM_DEDUCTION_BRANCH_IDS` in `apps/api/src/config/index.ts:82-110,166-180`) — never a global flip.
- Never weaken the advisory-lock / insufficient-stock / out-of-stock-cascade semantics `transactions.service.ts:deductInventoryForSale` already guarantees (l.566-668).
- All new write paths reuse `recordAuditLog`, matching every existing service in this codebase.
- No task deletes `ProductInventory`/`Ingredient` data or code until Phase 5, and only after the branch allowlist for Phase 3's flag covers 100% of active branches with zero shadow-mode mismatches for at least one full rollout window (operational gate, not a code gate — call this out to the user before Phase 5 starts).

---

## Phase Overview

| Phase | Delta (from brief) | Risk | Depends on |
|---|---|---|---|
| 1 | Symmetric `InventoryStock` provisioning (branch↔item fan-out) — brief tasks 5 & 6 | Low — additive, zero-stock rows only | none |
| 2 | Flavor-scoped `ProductComponent` | Medium — schema change, additive column | none |
| 3 | New-model checkout deduction path, feature-flagged | High — money/stock correctness | Phase 1, Phase 2 |
| 4 | Readiness / Publish / Variant Card cut to new model — brief tasks 2, 3, 4 | Medium — UI + gating logic | Phase 3 flag proven for a variant's branches |
| 5 | Full codebase sweep + legacy decommission — brief tasks 1 & 8 | Low (mechanical) once 1-4 done | Phases 1-4 |

Phase 1 is fully detailed below and ready to execute now. Phases 2-5 are scoped at task/file/signature level with real code for the highest-value pieces; each should get its own dedicated plan pass (same skill) once the prior phase has shipped and been observed, because their exact shape depends on what Phase 1-3 reveal in practice (e.g., real shadow-bom mismatch data doesn't exist yet).

---

## Phase 1: Symmetric InventoryStock Provisioning

**Files:**
- Modify: `apps/api/src/modules/branches/branches.service.ts:165-239` (`createBranch`)
- Modify: `apps/api/src/modules/universal-inventory/universal-inventory.service.ts:256-288` (`createItem`)
- Modify: `apps/api/src/modules/universal-inventory/universal-inventory.repository.ts` (add a bulk provisioning helper next to `assignToBranch`, l.151-168)
- Modify: `apps/api/src/modules/branches/branches.repository.ts` (add `findAllActiveIds`)
- Test: `apps/api/src/modules/branches/branches.service.test.ts`
- Test: `apps/api/src/modules/universal-inventory/universal-inventory.service.test.ts`
- Test: `apps/api/src/modules/branches/branches.integration.test.ts`

**Interfaces:**
- Consumes: `prisma.inventoryItem.findMany`, `prisma.inventoryStock.createMany` (Prisma client, already generated), `Prisma.TransactionClient` type already imported in `branches.service.ts`.
- Produces: `universalInventoryRepository.provisionBranchStock(branchId: string, tx?: Prisma.TransactionClient): Promise<void>` — creates a zero-stock `InventoryStock` row for every active `InventoryItem` in the given branch. `universalInventoryRepository.provisionItemAcrossBranches(inventoryItemId: string, branchIds: string[]): Promise<void>` — creates a zero-stock `InventoryStock` row for the given item in every listed branch. `branchesRepository.findAllActiveIds(tx?: Prisma.TransactionClient): Promise<string[]>`.

### Task 1.1: Add `provisionBranchStock` to the universal-inventory repository/service

- [ ] **Step 1: Write the failing test** — add to `apps/api/src/modules/universal-inventory/universal-inventory.service.test.ts`:

```ts
describe('provisionBranchStock', () => {
  it('creates a zero-stock InventoryStock row for every active InventoryItem', async () => {
    vi.mocked(prisma.inventoryItem.findMany).mockResolvedValue([
      { id: 'item-1' } as any,
      { id: 'item-2' } as any,
    ]);
    vi.mocked(prisma.inventoryStock.createMany).mockResolvedValue({ count: 2 });

    await universalInventoryService.provisionBranchStock('branch-1');

    expect(prisma.inventoryItem.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, trackInventory: true },
      select: { id: true },
    });
    expect(prisma.inventoryStock.createMany).toHaveBeenCalledWith({
      data: [
        { branchId: 'branch-1', inventoryItemId: 'item-1' },
        { branchId: 'branch-1', inventoryItemId: 'item-2' },
      ],
      skipDuplicates: true,
    });
  });

  it('is a no-op when there are no active inventory items', async () => {
    vi.mocked(prisma.inventoryItem.findMany).mockResolvedValue([]);

    await universalInventoryService.provisionBranchStock('branch-1');

    expect(prisma.inventoryStock.createMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run universal-inventory.service.test.ts -t provisionBranchStock`
Expected: FAIL — `universalInventoryService.provisionBranchStock is not a function`

- [ ] **Step 3: Implement the repository helper** — in `apps/api/src/modules/universal-inventory/universal-inventory.repository.ts`, add next to `assignToBranch` (l.166-168):

```ts
  listActiveTrackedItemIds(tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.inventoryItem.findMany({
      where: { deletedAt: null, trackInventory: true },
      select: { id: true },
    });
  },
  createStockRows(rows: { branchId: string; inventoryItemId: string }[], tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.inventoryStock.createMany({ data: rows, skipDuplicates: true });
  },
```

Add `import type { Prisma } from '@prisma/client';` at the top of the file if not already present.

- [ ] **Step 4: Implement the service function** — in `apps/api/src/modules/universal-inventory/universal-inventory.service.ts`, add after `createItem` (l.288):

```ts
  /**
   * Fan-out for new branches: every active, tracked InventoryItem gets a
   * zero-stock InventoryStock row in the new branch. Mirrors
   * inventoryService.provisionBranchIngredients for the legacy model.
   * Idempotent via skipDuplicates — safe to re-run.
   */
  async provisionBranchStock(branchId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const items = await repo.listActiveTrackedItemIds(tx);
    if (items.length === 0) return;
    await repo.createStockRows(
      items.map((item) => ({ branchId, inventoryItemId: item.id })),
      tx,
    );
  },

  /**
   * Fan-out for new items: the given InventoryItem gets a zero-stock
   * InventoryStock row in every listed branch. Mirrors
   * inventoryService.provisionIdentityAcrossBranches for the legacy model.
   * Idempotent via skipDuplicates.
   */
  async provisionItemAcrossBranches(inventoryItemId: string, branchIds: string[]): Promise<void> {
    if (branchIds.length === 0) return;
    await repo.createStockRows(branchIds.map((branchId) => ({ branchId, inventoryItemId })));
  },
```

Add `import type { Prisma } from '@prisma/client';` to this file's imports too.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run universal-inventory.service.test.ts -t provisionBranchStock`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/universal-inventory/universal-inventory.repository.ts apps/api/src/modules/universal-inventory/universal-inventory.service.ts apps/api/src/modules/universal-inventory/universal-inventory.service.test.ts
git commit -m "feat: add InventoryStock branch/item fan-out provisioning"
```

### Task 1.2: Wire `provisionBranchStock` into `createBranch`

- [ ] **Step 1: Write the failing test** — add to `apps/api/src/modules/branches/branches.service.test.ts`:

```ts
it('provisions zero-stock InventoryStock rows for every active InventoryItem on branch creation', async () => {
  vi.mocked(universalInventoryService.provisionBranchStock).mockResolvedValue(undefined);

  await branchesService.createBranch({ name: 'Test Branch', city: 'Manila' }, ACTOR, null);

  expect(universalInventoryService.provisionBranchStock).toHaveBeenCalledWith(expect.any(String), expect.anything());
});
```

Add `vi.mock('../universal-inventory/universal-inventory.service.js')` alongside the file's existing mocks, and import `universalInventoryService` at the top.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run branches.service.test.ts -t "provisions zero-stock"`
Expected: FAIL — `provisionBranchStock` never called

- [ ] **Step 3: Implement** — in `apps/api/src/modules/branches/branches.service.ts`, add the import:

```ts
import { universalInventoryService } from '../universal-inventory/universal-inventory.service.js';
```

Then inside the `prisma.$transaction` block in `createBranch` (l.185-218), immediately after the existing `provisionBranchIngredients` call (l.213-215):

```ts
      if (mergedIdentities.length > 0) {
        await inventoryService.provisionBranchIngredients(created.id, mergedIdentities, tx);
      }

      // CR-007 §20 item 9 — the new-model equivalent of the block above:
      // every active InventoryItem gets a zero-stock InventoryStock row in
      // this branch too, so recipe-readiness's INCOMPLETE_BRANCH_STOCK
      // blocker never fires for a branch created after this point.
      await universalInventoryService.provisionBranchStock(created.id, tx);

      return created;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run branches.service.test.ts -t "provisions zero-stock"`
Expected: PASS

- [ ] **Step 5: Run the branch integration test to confirm the transaction still commits atomically**

Run: `npx vitest run branches.integration.test.ts`
Expected: PASS (existing tests unaffected; add one asserting `InventoryStock` rows exist post-creation if the integration suite has DB access — follow the existing integration test's setup pattern in that file for seeding an `InventoryItem` first)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/branches/branches.service.ts apps/api/src/modules/branches/branches.service.test.ts
git commit -m "feat: provision InventoryStock rows when a branch is created"
```

### Task 1.3: Wire `provisionItemAcrossBranches` into `createItem`

- [ ] **Step 1: Write the failing test** — add to `apps/api/src/modules/universal-inventory/universal-inventory.service.test.ts`:

```ts
it('provisions InventoryStock rows in every active branch when a new item is created', async () => {
  vi.mocked(branchesRepository.findAllActiveIds).mockResolvedValue(['branch-1', 'branch-2']);
  vi.mocked(repo.createItem).mockResolvedValue({ id: 'item-9', name: 'Cheese Powder' } as any);

  await universalInventoryService.createItem({ name: 'Cheese Powder', baseUnitId: 'unit-1' }, ACTOR, null);

  expect(prisma.inventoryStock.createMany).toHaveBeenCalledWith({
    data: [
      { branchId: 'branch-1', inventoryItemId: 'item-9' },
      { branchId: 'branch-2', inventoryItemId: 'item-9' },
    ],
    skipDuplicates: true,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run universal-inventory.service.test.ts -t "provisions InventoryStock rows in every active branch"`
Expected: FAIL — `branchesRepository.findAllActiveIds` doesn't exist yet / not called

- [ ] **Step 3: Add `findAllActiveIds` to `branches.repository.ts`**

```ts
  findAllActiveIds(tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma;
    return client.branch.findMany({ where: { status: 'ACTIVE' }, select: { id: true } }).then((rows) => rows.map((r) => r.id));
  },
```

(Check `branches.repository.ts` for the exact `Branch.status` enum values already in use — the repository file's other queries, e.g. `findByCode`, show the established `where` shape; match it exactly rather than assuming `'ACTIVE'` is the literal — confirm against `schema.prisma`'s `BranchStatus` enum before writing this line.)

- [ ] **Step 4: Wire it into `createItem`** — in `universal-inventory.service.ts`, after `const item = await repo.createItem(data);` (l.274) and before the audit log call:

```ts
    const item = await repo.createItem(data);

    const activeBranchIds = await branchesRepository.findAllActiveIds();
    if (activeBranchIds.length > 0) {
      await this.provisionItemAcrossBranches(item.id, activeBranchIds);
    }

    const response = toItemResponse(item);
```

Add `import { branchesRepository } from '../branches/branches.repository.js';` to the top of the file. Note `this.provisionItemAcrossBranches` requires the service object to be referenced by name (`universalInventoryService.provisionItemAcrossBranches(...)`) rather than `this.` if the module exports a plain object literal — check the export shape at the bottom of the file and use whichever form matches the existing style (the file's other internal cross-calls, if any, show the convention).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run universal-inventory.service.test.ts -t "provisions InventoryStock rows in every active branch"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/universal-inventory/universal-inventory.service.ts apps/api/src/modules/universal-inventory/universal-inventory.service.test.ts apps/api/src/modules/branches/branches.repository.ts
git commit -m "feat: provision InventoryStock across all branches when a new item is created"
```

**Phase 1 exit check:** `npx vitest run branches universal-inventory` all green; manually create a branch and an item in a dev environment and confirm `InventoryStock` row counts match `(active branches) × (active tracked items)`.

---

## Phase 2: Flavor-Scoped ProductComponent (scoped, not yet step-by-step)

**Why this has to happen before Phase 3:** `product-readiness.service.ts` and `recipe-readiness.service.ts` both special-case flavor-linked `ProductInventory` rows (`LEGACY_FLAVOR_DEPENDENCY`, `RECIPE_FLAVOR_SCOPE_UNSUPPORTED`) precisely because `ProductComponent` cannot represent them yet. Cutting checkout over without this leaves every flavored product's stock deduction silently wrong.

**Files:**
- Modify: `apps/api/prisma/schema.prisma:1213-1254` (`ProductComponent`) — add `flavorId String? @map("flavor_id")` + `flavor Flavor? @relation(...)`, mirroring `ProductInventory.flavorId` (`schema.prisma:864-910`) field-for-field, including its partial-unique-index treatment (raw SQL migration, `(product_variant_id, inventory_item_id, flavor_id) WHERE deleted_at IS NULL`, replacing the current 2-column partial index).
- New migration: `apps/api/prisma/migrations/<timestamp>_cr011_3_product_component_flavor_scope/migration.sql`
- Modify: `apps/api/src/modules/product-components/product-components.repository.ts`, `.service.ts`, `.types.ts`, `.router.ts` — add `flavorId` through create/update/find, following `product-inventory.repository.ts`/`.service.ts`'s existing flavor handling as the reference implementation (same repo, sibling module — copy its resolution logic, don't reinvent it).
- Modify: `apps/api/src/modules/product-components/product-components-backfill.service.ts` — today it explicitly skips/flags flavor-linked `ProductInventory` rows as unmigratable; once flavor scoping exists, extend the backfill to migrate them.
- Modify: `apps/web/components/products/recipe-component-form-dialog.tsx`, `recipe-bom-panel.tsx` — add flavor selection, mirroring `inventory-mapping-form-dialog.tsx`'s flavor picker.
- Update: `packages/shared/src/schemas/product-component.schema.ts`.

**Recommended next step:** run this phase through `writing-plans` again on its own once Phase 1 has shipped, with the exact `ProductInventory` flavor-resolution code (`product-inventory.service.ts:resolveIngredientForBranch`, l.87) read in full and mirrored — that function's exact matching logic (by name across branches) needs to be replicated for `InventoryItem`, which is branch-agnostic by design, so the mirroring is simpler here (no name-matching needed, since `InventoryItem` already has one branch-agnostic identity) but still needs to be written out step by step with real code, not summarized.

---

## Phase 3: New-Model Checkout Deduction (scoped, not yet step-by-step)

**Files:**
- New: `apps/api/src/modules/product-components/component-deduction.service.ts` — `computeComponentDeduction`/`computeComponentDeductionForSlots`, `assertProductComponentsExist`, mirroring `product-inventory.service.ts:computeDeduction`/`computeDeductionForSlots`/`assertProductInventoryExists` (l.119-223) exactly in shape (same return type as `DeductionLine[]` from `product-inventory.types.ts`, so `transactions.service.ts` can select between them without branching its own logic).
- Modify: `apps/api/src/modules/inventory/inventory.repository.ts` — add `appendStockMovement`/an `InventoryStock`-targeted equivalent of whatever `appendMovement` does against `Ingredient.currentStock`, using `InventoryStock.version` for optimistic concurrency (the field already exists, unused today) instead of `Ingredient`'s implicit row lock — decide during that plan pass whether to keep the same `pg_advisory_xact_lock` pattern (keyed on `inventory_item_id` instead of `ingredient_id`) or lean on `version`-based optimistic retry; both are valid, but this is a decision the dedicated Phase 3 plan needs to make explicit and test, not something to inline here.
- Modify: `apps/api/src/modules/transactions/transactions.service.ts:362-365,447-472,566-668,680-720` — add a per-branch flag check (new `INVENTORY_STOCK_DEDUCTION_ENABLED` + `INVENTORY_STOCK_DEDUCTION_BRANCH_IDS`, same shape as `config/index.ts:82-110,166-180`) that selects `computeComponentDeduction*`/new deduction-application path instead of the legacy one, branch by branch. Keep both code paths live side by side (dead code is not acceptable long-term, but during rollout both must exist) until every branch is migrated.
- New config: `apps/api/src/config/index.ts` — add the two settings next to `SHADOW_BOM_DEDUCTION_ENABLED`.
- Reuse: `shadow-bom-deduction` module's existing comparison math as validation data before flipping any branch's flag to true — **do not flip a branch's flag until its `ShadowBomComparison` rows show zero `QUANTITY_MISMATCH`/`MISSING_BOM_COMPONENT` classifications over a representative sales window.** This is an operational gate the dedicated Phase 3 plan must state as an explicit pre-flight check, not something to skip because it's inconvenient.

**Recommended next step:** this is the highest-risk phase in the whole migration (it changes what gets deducted for real money-taking transactions). Do not execute it from a summarized task list — run `writing-plans` again for this phase alone, in a git worktree, after Phase 1 and 2 have shipped and after pulling real `ShadowBomComparison` data to see how close the new model actually is to the legacy one in production today.

---

## Phase 4: Readiness / Publish / Variant Card Cutover (scoped, not yet step-by-step)

**Files:**
- Modify: `apps/api/src/modules/product-readiness/product-readiness.service.ts` — replace `BASE_INVENTORY_MAPPING_MISSING`/`FLAVOR_INVENTORY_MAPPING_MISSING`/`UNLINKED_FLAVOR_MAPPING` checks (currently sourced from `productInventoryRepository.findActiveMappingsForVariants`) with `ProductComponent`/`InventoryStock`-sourced equivalents — largely a rename/re-source of an already-written check, since `recipe-readiness.service.ts` already computes the equivalent statuses (`NO_RECIPE`, `INVALID_COMPONENT`, `INCOMPLETE_BRANCH_STOCK`) on the new model; the target state is one readiness engine, not two.
- Modify: `apps/api/src/modules/products/products.service.ts:1355-1379` (`publishProduct`/`unpublishProduct`) — no change needed if Phase 4's readiness update is done first, since publish already gates on `productReadinessService.evaluateProductReadiness` output, not on `ProductInventory` directly (confirmed in the audit — publish never reads `ProductInventory` itself today, it reads readiness, which reads `ProductInventory`; fixing readiness fixes publish for free).
- Modify: `apps/web/components/admin/products/variant-card.tsx:87-89,148-304` — delete `InventoryItemsSection` and its "blocks POS sale" banner (l.176-224); the `RecipeBomPanel` already embedded at l.87-89 becomes the sole inventory-mapping UI on the card. Add stock-on-hand display (per branch) to `RecipeBomPanel` or a small sibling component reading `InventoryStock` via a new `useInventoryStockForItem`-style hook next to `use-product-components.ts`.
- Delete once unused: `apps/web/components/admin/products/inventory-mapping-form-dialog.tsx`, `apps/web/hooks/queries/use-product-inventory.ts` (only after confirming no other component imports them — grep first).

**Recommended next step:** this phase can only start once Phase 3's flag is proven for the branches a given variant sells in — a variant flipped to new-model readiness/UI while its branch is still on legacy deduction would show "ready" in the UI but deduct from the wrong stock at checkout. Sequence per-branch, not globally.

---

## Phase 5: Full Codebase Sweep + Legacy Decommission (scoped, not yet step-by-step)

**Process:** once Phases 1-4 have shipped and every active branch's flag from Phase 3 is on, re-run the same kind of exhaustive grep sweep the initial audit did (`ProductInventory`, `Ingredient`, plus their Prisma model names `product_inventory`/`ingredients`) across `apps/api/src`, `apps/web`, `packages/shared/src`. Every hit from the audit's §2 list gets one of two dispositions:

- **Delete** — `product-inventory` module (repository/service/router/types), `inventory-mapping-form-dialog.tsx`, `use-product-inventory.ts`, `shadow-bom-deduction` module (its job is done once there's no more "shadow" — only one model left to compare against itself), `inventory-migration` dry-run tooling (superseded by the fact that migration is complete), the two now-unused feature flags.
- **Keep, re-justified** — `InventoryMovement`/`Ingredient` tables themselves should NOT be dropped in this phase; keep them as historical audit ledger (financial/inventory history should never be hard-deleted) but mark them `@deprecated` in schema comments and remove all write paths. Actually dropping the tables is a separate, later decision requiring explicit sign-off (data retention policy), not something this migration decides unilaterally.

**Deliverable for this phase:** a literal diff/list matching the brief's requested "AFTER IMPLEMENTATION" report format — remaining legacy references (should be zero in live code paths, some intentionally kept in historical/audit-only code), modified files, migration summary, tests executed, deployment readiness. Write this phase's own plan once Phase 4 is done and the actual remaining-reference list is known — guessing it now would violate the "no placeholders" rule this skill exists to enforce.

---

## Self-Review Notes

- **Spec coverage:** brief tasks 5 & 6 → Phase 1 (fully specified). Task 2 (readiness) & 3 (publish) & 4 (variant card) → Phase 4. Task 7 (checkout) → Phase 3. Task 1 & 8 (search/replace everywhere, report) → Phase 5. Prerequisite the brief didn't call out but the schema itself documents as blocking → Phase 2 (flavor scoping).
- **Placeholder scan:** Phase 1 has zero placeholders — every step has real code, real file paths, real commands. Phases 2-5 are intentionally left at task/file/signature granularity with an explicit note on why (real production data and Phase 1-3 outcomes are prerequisites for writing their exact code) rather than filled with fake "add validation"-style steps — this is a scope decision, documented above, not an oversight.
- **Type consistency:** `provisionBranchStock`/`provisionItemAcrossBranches` signatures in Task 1.1 match their call sites in Tasks 1.2/1.3 exactly (same names, same parameter order).
