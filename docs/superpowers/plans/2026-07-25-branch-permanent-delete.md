# Branch Permanent Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Permanently Delete Branch" action to the branch Settings tab's Danger Zone that hard-deletes a branch and cascades away all of its data (transactions, shifts, inventory, expenses, attendance, etc.), guarded only by active-shift and pending-inventory-request checks.

**Architecture:** Schema-level cascade (Prisma `onDelete: Cascade` / already-`SetNull` FK actions) so a single `prisma.branch.delete()` call does the whole deletion atomically in the database. The service layer adds two pre-flight guards (active shifts, pending inventory requests) and one audit-log write before calling it. The frontend adds a two-field-confirmation dialog (branch name + literal `DELETE`) matching the existing Danger Zone pattern.

**Tech Stack:** Next.js 15 / React 19 (frontend), Express 5 + Prisma (backend), Postgres via Supabase, Vitest (unit tests), Playwright (e2e).

## Global Constraints

- TypeScript strict mode, no `any`, no `!` without a comment explaining why it's safe (project CLAUDE.md).
- No direct Prisma calls outside the repository layer (project CLAUDE.md).
- Conventional commits, imperative mood (project CLAUDE.md).
- Never run `prisma migrate dev` or any `prisma migrate` command without first verifying `DIRECT_URL`'s actual target — this project's local CLI is linked to the **production** Supabase project (`nliuhztaezaujzgtsrwp`; verified via `supabase/.temp/project-ref` this session) — see project CLAUDE.md "Database & Migration Safety".
- Design spec: `docs/superpowers/specs/2026-07-25-branch-permanent-delete-design.md` — read it before starting Task 1; it documents *why* each schema decision was made (Recipe pinning accepted-risk, InventoryRequest Restrict→Cascade correction, transitive-cascade gaps), which this plan assumes as settled.

---

## Task 1: Prisma schema — cascade/set-null FK actions + hand-authored migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260725190000_branch_permanent_delete_cascade/migration.sql`

**Interfaces:**
- Produces: every FK listed below now cascades (or, for `AuditLog`/`FraudAlert`, already does — verified, no change) when a `Branch` row is deleted via `prisma.branch.delete()`. Later tasks depend on this: Task 3's `branchesRepository.delete()` assumes the DB enforces the cascade, not application code.

This task is pure schema/SQL — no application code depends on the DB actually having this migration applied yet (Tasks 2–9 all run against Vitest-mocked Prisma clients). Applying the migration to a real database is deliberately deferred to Task 10, which has its own safety checkpoint.

- [ ] **Step 1: Edit `schema.prisma` — add `onDelete: Cascade` to the 14 direct branch-child relations**

Each edit below is a minimal one-line change (add `, onDelete: Cascade` before the closing `)`). Apply all 14:

`UserBranchAssignment` (around line 330):
```prisma
  branch Branch @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`BranchProductAvailability` (around line 598):
```prisma
  branch  Branch  @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`BranchFlavorAvailability` (around line 614):
```prisma
  branch Branch @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`BranchPriceOverride` (around line 647):
```prisma
  branch         Branch         @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`ProductRequest` (around line 684):
```prisma
  branch         Branch   @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`FlavorRequest` (around line 717):
```prisma
  branch        Branch  @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`Ingredient` (around line 753):
```prisma
  branch            Branch                 @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`BranchRecipeOverride` (around line 823):
```prisma
  branch         Branch         @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`InventoryMovement` (around line 899):
```prisma
  branch     Branch     @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`Transaction` (around line 968):
```prisma
  branch     Branch            @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`Shift` (around line 1055):
```prisma
  branch  Branch @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`HoldOrder` (around line 1088):
```prisma
  branch  Branch          @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`AttendanceRecord` (around line 1171):
```prisma
  branch         Branch             @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

`Expense` (around line 1331):
```prisma
  branch  Branch @relation(fields: [branchId], references: [id], onDelete: Cascade)
```

Because `BranchPriceOverride` and `BranchRecipeOverride` currently have byte-identical relation lines (`  branch         Branch         @relation(fields: [branchId], references: [id])`), and `Shift` and `Expense` also currently have byte-identical relation lines (`  branch  Branch @relation(fields: [branchId], references: [id])`), do **not** edit by searching for the relation line text alone — it will match the wrong model. Open the file at the line number given, confirm the model name a few lines above, then edit that specific occurrence.

- [ ] **Step 2: Edit `schema.prisma` — `InventoryRequest`: change both FKs from `Restrict` to `Cascade`**

Around line 1306–1309, currently:
```prisma
  branch      Branch     @relation(fields: [branchId], references: [id], onDelete: Restrict)
  ingredient  Ingredient @relation(fields: [ingredientId], references: [id], onDelete: Restrict)
  requestedBy User       @relation("RequestedInventoryRequests", fields: [requestedById], references: [id], onDelete: Restrict)
  approvedBy  User?      @relation("ApprovedInventoryRequests", fields: [approvedById], references: [id], onDelete: Restrict)
```

Change only the first two lines (leave `requestedBy`/`approvedBy` as `Restrict` — those point at `User`, unaffected by this feature):
```prisma
  branch      Branch     @relation(fields: [branchId], references: [id], onDelete: Cascade)
  ingredient  Ingredient @relation(fields: [ingredientId], references: [id], onDelete: Cascade)
  requestedBy User       @relation("RequestedInventoryRequests", fields: [requestedById], references: [id], onDelete: Restrict)
  approvedBy  User?      @relation("ApprovedInventoryRequests", fields: [approvedById], references: [id], onDelete: Restrict)
```

- [ ] **Step 3: Edit `schema.prisma` — three transitive-cascade gaps**

These tables have no `branchId` column of their own; their only path to `Branch` is through a parent that Steps 1–2 now cascade. Without these three, deleting `Transaction`/`HoldOrder`/`Shift` rows (which Step 1 makes cascade from `Branch`) would itself fail with a Restrict violation.

`TransactionItem` (around line 1010), currently:
```prisma
  transaction    Transaction    @relation(fields: [transactionId], references: [id])
```
Change to:
```prisma
  transaction    Transaction    @relation(fields: [transactionId], references: [id], onDelete: Cascade)
```

`HoldOrderItem` (around line 1116), currently:
```prisma
  holdOrder      HoldOrder      @relation(fields: [holdOrderId], references: [id])
```
Change to:
```prisma
  holdOrder      HoldOrder      @relation(fields: [holdOrderId], references: [id], onDelete: Cascade)
```

`ShiftCashDenomination` (around line 1133), currently:
```prisma
  shift Shift @relation(fields: [shiftId], references: [id])
```
Change to:
```prisma
  shift Shift @relation(fields: [shiftId], references: [id], onDelete: Cascade)
```

- [ ] **Step 4: Edit `schema.prisma` — `Recipe.ingredient` (accepted-risk cascade)**

Around line 792, currently:
```prisma
  ingredient     Ingredient     @relation(fields: [ingredientId], references: [id])
```
Change to:
```prisma
  ingredient     Ingredient     @relation(fields: [ingredientId], references: [id], onDelete: Cascade)
```

This is the master-recipe-pinning decision from the design doc: deleting a branch that's the pinned identity source for a recipe now deletes that master `Recipe` row too. Deliberate, user-accepted — do not add a guard for it.

Do **not** touch `AuditLog.branch` or `FraudAlert.branch` — verified against `migrations/20260709172014_init/migration.sql`, both already have `ON DELETE SET NULL` in the live schema (Prisma's implicit default for a nullable FK column with no explicit `onDelete`). No edit needed.

- [ ] **Step 5: Verify the schema is syntactically valid**

Run: `cd apps/api && npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀` — this only parses the schema file, it does not touch any database.

- [ ] **Step 6: Regenerate the Prisma client**

Run: `cd apps/api && npx prisma generate`
Expected: `✔ Generated Prisma Client` — this reads the schema and writes TypeScript types/client code locally; it does not touch any database. Tasks 2–3 need the regenerated client's types (though the delete/count methods used are simple enough that this mainly matters for `Prisma.BranchDelegate['delete']`'s type).

- [ ] **Step 7: Hand-author the migration SQL**

Create `apps/api/prisma/migrations/20260725190000_branch_permanent_delete_cascade/migration.sql`. This is authored by hand rather than via `prisma migrate dev` deliberately — `migrate dev` requires a live DB connection to diff against, and per the Global Constraints this project's local `DIRECT_URL` currently resolves to the production Supabase project. Hand-authoring means Step 5–6 (schema validate/generate) can be verified with zero risk of accidentally running a diff/apply against production, and the actual apply is a separate, explicitly-gated step (Task 10).

```sql
-- Branch Permanent Delete — cascade/restrict FK corrections
-- See docs/superpowers/specs/2026-07-25-branch-permanent-delete-design.md

-- Direct children of Branch (branch_id / branchId FK): Restrict -> Cascade
ALTER TABLE "user_branch_assignments" DROP CONSTRAINT "user_branch_assignments_branch_id_fkey";
ALTER TABLE "user_branch_assignments" ADD CONSTRAINT "user_branch_assignments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "branch_product_availability" DROP CONSTRAINT "branch_product_availability_branch_id_fkey";
ALTER TABLE "branch_product_availability" ADD CONSTRAINT "branch_product_availability_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "branch_flavor_availability" DROP CONSTRAINT "branch_flavor_availability_branch_id_fkey";
ALTER TABLE "branch_flavor_availability" ADD CONSTRAINT "branch_flavor_availability_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "branch_price_overrides" DROP CONSTRAINT "branch_price_overrides_branch_id_fkey";
ALTER TABLE "branch_price_overrides" ADD CONSTRAINT "branch_price_overrides_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_requests" DROP CONSTRAINT "product_requests_branch_id_fkey";
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "flavor_requests" DROP CONSTRAINT "flavor_requests_branch_id_fkey";
ALTER TABLE "flavor_requests" ADD CONSTRAINT "flavor_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ingredients" DROP CONSTRAINT "ingredients_branch_id_fkey";
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "branch_recipe_overrides" DROP CONSTRAINT "branch_recipe_overrides_branch_id_fkey";
ALTER TABLE "branch_recipe_overrides" ADD CONSTRAINT "branch_recipe_overrides_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_branch_id_fkey";
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transactions" DROP CONSTRAINT "transactions_branch_id_fkey";
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shifts" DROP CONSTRAINT "shifts_branch_id_fkey";
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hold_orders" DROP CONSTRAINT "hold_orders_branch_id_fkey";
ALTER TABLE "hold_orders" ADD CONSTRAINT "hold_orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "attendance_records" DROP CONSTRAINT "attendance_records_branch_id_fkey";
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "expenses" DROP CONSTRAINT "expenses_branch_id_fkey";
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- InventoryRequest: Restrict -> Cascade on both branchId and ingredientId
-- (this table's columns are camelCase in the DB, no snake_case @map — see schema.prisma)
ALTER TABLE "inventory_requests" DROP CONSTRAINT "inventory_requests_branchId_fkey";
ALTER TABLE "inventory_requests" ADD CONSTRAINT "inventory_requests_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inventory_requests" DROP CONSTRAINT "inventory_requests_ingredientId_fkey";
ALTER TABLE "inventory_requests" ADD CONSTRAINT "inventory_requests_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Transitive-cascade gaps: children with no branchId column of their own
ALTER TABLE "transaction_items" DROP CONSTRAINT "transaction_items_transaction_id_fkey";
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hold_order_items" DROP CONSTRAINT "hold_order_items_hold_order_id_fkey";
ALTER TABLE "hold_order_items" ADD CONSTRAINT "hold_order_items_hold_order_id_fkey" FOREIGN KEY ("hold_order_id") REFERENCES "hold_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shift_cash_denominations" DROP CONSTRAINT "shift_cash_denominations_shift_id_fkey";
ALTER TABLE "shift_cash_denominations" ADD CONSTRAINT "shift_cash_denominations_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Master Recipe pinning — accepted-risk cascade (see design doc "Recipe pinning" section):
-- deleting a branch that's the pinned identity source for a recipe deletes that master
-- Recipe row too, breaking deduction for that product at every branch. Deliberate.
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_ingredient_id_fkey";
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- audit_logs.branch_id and fraud_alerts.branch_id already ON DELETE SET NULL since the
-- initial migration (20260709172014_init) — no change needed, intentionally not touched here.
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260725190000_branch_permanent_delete_cascade/migration.sql
git commit -m "feat(branches): cascade FK schema for permanent branch delete"
```

---

## Task 2: Repository layer — `delete` and `countPendingInventoryRequests`

**Files:**
- Modify: `apps/api/src/modules/branches/branches.repository.ts`
- Test: `apps/api/src/modules/branches/branches.repository.test.ts`

**Interfaces:**
- Consumes: `prisma.branch.delete`, `prisma.inventoryRequest.count` (Prisma client, from `../../lib/prisma.js`).
- Produces: `branchesRepository.delete(branchId: string): Promise<Branch>`, `branchesRepository.countPendingInventoryRequests(branchId: string): Promise<number>` — Task 3's service layer calls both by these exact names.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/modules/branches/branches.repository.test.ts`, after the existing `describe('branchesRepository.branchStats', ...)` block (before its closing nothing else follows — append at end of file):

```typescript
describe('branchesRepository.countPendingInventoryRequests', () => {
  it('counts only pending inventory requests for the branch', async () => {
    vi.mocked(prisma.inventoryRequest.count).mockResolvedValue(3);

    const count = await branchesRepository.countPendingInventoryRequests('branch-1');

    expect(count).toBe(3);
    expect(prisma.inventoryRequest.count).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', status: 'pending' },
    });
  });
});

describe('branchesRepository.delete', () => {
  it('deletes the branch by id', async () => {
    vi.mocked(prisma.branch.delete).mockResolvedValue({ id: 'branch-1' } as never);

    await branchesRepository.delete('branch-1');

    expect(prisma.branch.delete).toHaveBeenCalledWith({ where: { id: 'branch-1' } });
  });
});
```

Also add the two new mocked methods to the `vi.mock('../../lib/prisma.js', ...)` factory near the top of the file so the above compiles and resolves as mocks:

```typescript
vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    branch: { findMany: vi.fn(), delete: vi.fn() },
    shift: { groupBy: vi.fn(), count: vi.fn() },
    userBranchAssignment: { groupBy: vi.fn(), count: vi.fn() },
    transaction: { groupBy: vi.fn(), aggregate: vi.fn() },
    expense: { groupBy: vi.fn(), aggregate: vi.fn() },
    ingredient: { findMany: vi.fn() },
    inventoryRequest: { count: vi.fn() },
  };
  return { prisma: prismaMock };
});
```

(Only the `branch: { ..., delete: vi.fn() }` and `inventoryRequest: { count: vi.fn() }` lines are new — the rest already exists in the file, shown here for full context of the object literal being edited.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/modules/branches/branches.repository.test.ts`
Expected: FAIL — `branchesRepository.countPendingInventoryRequests is not a function` and `branchesRepository.delete is not a function`.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/branches/branches.repository.ts`, add these two methods to the `branchesRepository` object, right after `countActiveShifts` (which currently ends the block starting at `countActiveShifts(branchId: string) {`):

```typescript
  countActiveShifts(branchId: string) {
    return prisma.shift.count({ where: { branchId, status: 'active' } });
  },

  countPendingInventoryRequests(branchId: string) {
    return prisma.inventoryRequest.count({ where: { branchId, status: 'pending' } });
  },

  delete(branchId: string) {
    return prisma.branch.delete({ where: { id: branchId } });
  },
```

(The `countActiveShifts` line is existing code shown for placement context — only the two new methods below it are additions.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/modules/branches/branches.repository.test.ts`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/branches/branches.repository.ts apps/api/src/modules/branches/branches.repository.test.ts
git commit -m "feat(branches): add repository delete and countPendingInventoryRequests"
```

---

## Task 3: Service layer — `deleteBranch`

**Files:**
- Modify: `apps/api/src/modules/branches/branches.service.ts`
- Test: `apps/api/src/modules/branches/branches.service.test.ts`

**Interfaces:**
- Consumes: `branchesRepository.findById`, `branchesRepository.countActiveShifts`, `branchesRepository.countPendingInventoryRequests`, `branchesRepository.delete` (Task 2), `recordAuditLog` (`../../middleware/audit-log.js`), `getIO`/`SUPER_ADMIN_ROOM` (existing imports), `SOCKET_EVENTS.BRANCH_DELETED` (Task 5 — this task can be written and tested before Task 5 lands, since the test mocks `@potato-corner/shared`'s `SOCKET_EVENTS` the same way the existing `changeBranchStatus` tests do; the real constant just needs to exist before this code runs against a real build).
- Produces: `branchesService.deleteBranch(branchId: string, deletedBy: { id: string; role: string }, ipAddress: string | null): Promise<void>` — Task 4's router calls this by this exact name and signature.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/modules/branches/branches.service.test.ts`, immediately after the closing `});` of the existing `describe('branchesService.changeBranchStatus', ...)` block (the one ending with the `'to closed with no active shifts succeeds'` test):

```typescript
describe('branchesService.deleteBranch', () => {
  it('with active shifts throws BRANCH_HAS_ACTIVE_SHIFTS and never deletes', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(buildBranch() as never);
    vi.mocked(branchesRepository.countActiveShifts).mockResolvedValue(1);

    await expect(
      branchesService.deleteBranch('branch-1', ACTOR, null),
    ).rejects.toMatchObject({
      code: 'BRANCH_HAS_ACTIVE_SHIFTS',
      statusCode: 409,
    });

    expect(branchesRepository.delete).not.toHaveBeenCalled();
  });

  it('with pending inventory requests throws BRANCH_HAS_PENDING_INVENTORY_REQUESTS and never deletes', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(buildBranch() as never);
    vi.mocked(branchesRepository.countActiveShifts).mockResolvedValue(0);
    vi.mocked(branchesRepository.countPendingInventoryRequests).mockResolvedValue(2);

    await expect(
      branchesService.deleteBranch('branch-1', ACTOR, null),
    ).rejects.toMatchObject({
      code: 'BRANCH_HAS_PENDING_INVENTORY_REQUESTS',
      statusCode: 409,
    });

    expect(branchesRepository.delete).not.toHaveBeenCalled();
  });

  it('with no branch found throws BRANCH_NOT_FOUND', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(null);

    await expect(
      branchesService.deleteBranch('branch-missing', ACTOR, null),
    ).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('with no active shifts and no pending inventory requests deletes and records a BRANCH_DELETED audit entry', async () => {
    vi.mocked(branchesRepository.findById).mockResolvedValue(
      buildBranch({ id: 'branch-9', name: 'Old Branch', code: 'PC-MNL-009' }) as never,
    );
    vi.mocked(branchesRepository.countActiveShifts).mockResolvedValue(0);
    vi.mocked(branchesRepository.countPendingInventoryRequests).mockResolvedValue(0);
    vi.mocked(branchesRepository.delete).mockResolvedValue(undefined as never);

    await branchesService.deleteBranch('branch-9', ACTOR, '127.0.0.1');

    expect(branchesRepository.delete).toHaveBeenCalledWith('branch-9');
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'BRANCH_DELETED',
        entityType: 'branch',
        entityId: 'branch-9',
        actorId: ACTOR.id,
        branchId: 'branch-9',
        beforeState: expect.objectContaining({ name: 'Old Branch', code: 'PC-MNL-009' }),
        ipAddress: '127.0.0.1',
      }),
    );
  });
});
```

Also add the two new mocked methods to the existing `vi.mock('./branches.repository.js', ...)` factory near the top of the file:

```typescript
vi.mock('./branches.repository.js', () => ({
  branchesRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    findByIds: vi.fn(),
    findByCode: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getActiveAssignments: vi.fn(),
    findActiveAssignment: vi.fn(),
    assignUser: vi.fn(),
    removeUserAssignment: vi.fn(),
    getUserActiveBranches: vi.fn(),
    findUserById: vi.fn(),
    countActiveShifts: vi.fn(),
    countPendingInventoryRequests: vi.fn(),
    branchStats: vi.fn(),
    generateBranchCode: vi.fn(),
    findAllAccounts: vi.fn(),
    findAllStatsGrouped: vi.fn(),
  },
}));
```

(Only `delete: vi.fn(),` and `countPendingInventoryRequests: vi.fn(),` are new — the rest is existing code shown for placement context.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/modules/branches/branches.service.test.ts`
Expected: FAIL — `branchesService.deleteBranch is not a function`.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/branches/branches.service.ts`, add this method to the `branchesService` object, right after `changeBranchStatus` (which currently ends with `return toBranchResponse(branch);\n  },` before `assignSupervisor` begins):

```typescript
  async deleteBranch(branchId: string, deletedBy: { id: string; role: string }, ipAddress: string | null) {
    const before = await branchesRepository.findById(branchId);
    if (!before) throw new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404);

    const activeShifts = await branchesRepository.countActiveShifts(branchId);
    if (activeShifts > 0) {
      throw new BranchError(
        'BRANCH_HAS_ACTIVE_SHIFTS',
        'Cannot permanently delete a branch with active shifts — close all shifts first',
        409,
      );
    }

    const pendingInventoryRequests = await branchesRepository.countPendingInventoryRequests(branchId);
    if (pendingInventoryRequests > 0) {
      throw new BranchError(
        'BRANCH_HAS_PENDING_INVENTORY_REQUESTS',
        'Cannot permanently delete a branch with pending inventory requests — resolve them first',
        409,
      );
    }

    await recordAuditLog({
      action: 'BRANCH_DELETED',
      entityType: 'branch',
      entityId: before.id,
      actorId: deletedBy.id,
      actorRole: deletedBy.role,
      branchId: before.id,
      beforeState: { name: before.name, code: before.code, city: before.city, status: before.status },
      ipAddress,
    });

    await branchesRepository.delete(branchId);

    getIO()?.to(SUPER_ADMIN_ROOM).emit(SOCKET_EVENTS.BRANCH_DELETED, { branchId });
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/modules/branches/branches.service.test.ts`
Expected: PASS, all tests including the four new ones. (`SOCKET_EVENTS.BRANCH_DELETED` will be `undefined` until Task 5 lands — that's fine, `getIO()` already returns `null` in this test file's mock of `../../socket/socket.server.js`, so the `?.` short-circuits and the emit line never actually reads the property in a way that fails a test. If TypeScript complains that `BRANCH_DELETED` doesn't exist on `SOCKET_EVENTS`, do Task 5 first — the two tasks have a soft ordering dependency on the type, not the runtime behavior.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/branches/branches.service.ts apps/api/src/modules/branches/branches.service.test.ts
git commit -m "feat(branches): add deleteBranch service method with active-shift and pending-request guards"
```

---

## Task 4: Router — `DELETE /branches/:branchId`

**Files:**
- Modify: `apps/api/src/modules/branches/branches.router.ts`
- Test: `apps/api/src/modules/branches/branches.router.test.ts`

**Interfaces:**
- Consumes: `branchesService.deleteBranch` (Task 3).
- Produces: `DELETE /api/branches/:branchId` route — `adminOnly`, returns `204` on success.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/modules/branches/branches.router.test.ts`, after the existing `describe('PATCH /api/branches/:branchId — role guard', ...)` block closes (before the `POST /api/branches/:branchId/gcash-qr` describe block begins) — placed here so it groups with the other `/:branchId`-scoped route tests:

```typescript
describe('DELETE /api/branches/:branchId — role guard', () => {
  const ROUTE = '/:branchId';

  it('returns 401 with no Authorization header', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'delete', ROUTE);
    const res = mockRes();
    await runHandlers(handlers, mockReq({ params: { branchId: randomUUID() } }), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'delete', ROUTE);
    const branchId = randomUUID();
    const token = generateSupervisorToken([branchId]);
    const res = mockRes();

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.deleteBranch).not.toHaveBeenCalled();
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'delete', ROUTE);
    const branchId = randomUUID();
    const token = generateStaffToken(branchId);
    const res = mockRes();

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(branchesService.deleteBranch).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/branches/:branchId — success', () => {
  const ROUTE = '/:branchId';

  it('returns 204 and calls the service with branchId, actor, and ip', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'delete', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.deleteBranch).mockResolvedValue(undefined);

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(branchesService.deleteBranch).toHaveBeenCalledWith(
      branchId,
      expect.objectContaining({ role: 'super_admin' }),
      null,
    );
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
  });

  it('returns 409 when the branch has active shifts', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'delete', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.deleteBranch).mockRejectedValue(
      new BranchError(
        'BRANCH_HAS_ACTIVE_SHIFTS',
        'Cannot permanently delete a branch with active shifts — close all shifts first',
        409,
      ),
    );

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('returns 404 when the branch does not exist', async () => {
    const handlers = getRouteHandlers(branchesRouter, 'delete', ROUTE);
    const branchId = randomUUID();
    const token = generateSuperAdminToken();
    const res = mockRes();
    vi.mocked(branchesService.deleteBranch).mockRejectedValue(
      new BranchError('BRANCH_NOT_FOUND', 'Branch not found', 404),
    );

    await runHandlers(handlers, mockReq({ ...authHeader(token), params: { branchId } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
```

Note: `getRouteHandlers(branchesRouter, 'delete', '/:branchId')` will find the **first** registered route matching method `delete` and path `/:branchId`. After Step 3 there is exactly one — this route — so no ambiguity.

Also add `deleteBranch: vi.fn(),` to the existing `vi.mock('./branches.service.js', ...)` factory near the top of the file:

```typescript
vi.mock('./branches.service.js', () => ({
  branchesService: {
    bulkAssignGcashQr: vi.fn(),
    getBranchById: vi.fn(),
    updateBranch: vi.fn(),
    deleteBranch: vi.fn(),
    uploadGcashQr: vi.fn(),
    changeBranchStatus: vi.fn(),
    getAssignments: vi.fn(),
    assignSupervisor: vi.fn(),
    removeSupervisor: vi.fn(),
    getBranchStats: vi.fn(),
  },
}));
```

(Only `deleteBranch: vi.fn(),` is new.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/modules/branches/branches.router.test.ts`
Expected: FAIL — `getRouteHandlers` throws `No route registered for DELETE /:branchId`.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/branches/branches.router.ts`, add this route right after the `router.patch('/:branchId', ...)` block closes (before `router.post('/:branchId/gcash-qr', ...)` begins):

```typescript
router.delete('/:branchId', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    await branchesService.deleteBranch(
      req.params.branchId as string,
      { id: req.user.user_id, role: req.user.role },
      req.ip ?? null,
    );
    res.status(204).send();
  } catch (error) {
    handleBranchError(error, res, next);
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/modules/branches/branches.router.test.ts`
Expected: PASS, all tests including the six new ones.

- [ ] **Step 5: Run the full API test suite to check for regressions**

Run: `cd apps/api && npx vitest run`
Expected: PASS, no regressions in other modules.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/branches/branches.router.ts apps/api/src/modules/branches/branches.router.test.ts
git commit -m "feat(branches): add DELETE /branches/:branchId route"
```

---

## Task 5: Shared package — `BRANCH_DELETED` socket event

**Files:**
- Modify: `packages/shared/src/constants/events.ts`

**Interfaces:**
- Produces: `SOCKET_EVENTS.BRANCH_DELETED: 'branch:deleted'` — consumed by Task 3 (backend emit) and Task 6 (frontend realtime invalidation).

- [ ] **Step 1: Implement**

In `packages/shared/src/constants/events.ts`, find:
```typescript
  BRANCH_CREATED: 'branch:created',
  BRANCH_STATUS_CHANGED: 'branch:status_changed',
```
Change to:
```typescript
  BRANCH_CREATED: 'branch:created',
  BRANCH_STATUS_CHANGED: 'branch:status_changed',
  BRANCH_DELETED: 'branch:deleted',
```

- [ ] **Step 2: Rebuild the shared package**

Run: `cd packages/shared && npm run build` (or the repo's equivalent — check `packages/shared/package.json` `scripts.build`; if the monorepo uses live TS path resolution in dev with no separate build step for this package, this step is a no-op and can be skipped — verify by checking whether `apps/api`/`apps/web` import `@potato-corner/shared` from a `dist/` output or directly via a workspace TS reference).

- [ ] **Step 3: Run the API test suite to confirm no type errors from the new constant**

Run: `cd apps/api && npx vitest run src/modules/branches`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/constants/events.ts
git commit -m "feat(shared): add BRANCH_DELETED socket event constant"
```

---

## Task 6: Frontend hook — `useDeleteBranch`

**Files:**
- Modify: `apps/web/hooks/queries/use-branches.ts`

**Interfaces:**
- Consumes: `apiClient` (`@/lib/api-client`), `SOCKET_EVENTS.BRANCH_DELETED` (Task 5).
- Produces: `useDeleteBranch(branchId: string)` — a TanStack `useMutation` result whose `mutateAsync()` takes no arguments and resolves on success. Task 8's `DeleteBranchDialog` calls `useDeleteBranch(branch.id)` and then `.mutateAsync()`.

- [ ] **Step 1: Implement the hook**

In `apps/web/hooks/queries/use-branches.ts`, add this function after `useChangeBranchStatus` (which currently ends right before `useAssignSupervisor` begins):

```typescript
/** DELETE /api/branches/:branchId — permanent, cascading hard delete. */
export function useDeleteBranch(branchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient<null>(`/api/branches/${branchId}`, { method: 'DELETE' });
      if (response.error) throw new Error(errorMessage(response, 'Failed to delete branch'));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['branches'] });
      queryClient.removeQueries({ queryKey: ['branch', branchId] });
      toast.success('Branch permanently deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
```

`removeQueries` (not `invalidateQueries`) for the single-branch query — the branch no longer exists, so invalidating would just trigger a refetch that 404s.

- [ ] **Step 2: Add `BRANCH_DELETED` to the realtime sync event list**

In the same file, find `useBranchRealtimeSync`:
```typescript
export function useBranchRealtimeSync(): void {
  useRealtimeInvalidate(
    [
      SOCKET_EVENTS.BRANCH_CREATED,
      SOCKET_EVENTS.BRANCH_STATUS_CHANGED,
      SOCKET_EVENTS.BRANCH_SUPERVISOR_ASSIGNED,
      SOCKET_EVENTS.BRANCH_SUPERVISOR_REMOVED,
    ],
    [['branches'], ['branch']],
  );
}
```
Change to:
```typescript
export function useBranchRealtimeSync(): void {
  useRealtimeInvalidate(
    [
      SOCKET_EVENTS.BRANCH_CREATED,
      SOCKET_EVENTS.BRANCH_STATUS_CHANGED,
      SOCKET_EVENTS.BRANCH_SUPERVISOR_ASSIGNED,
      SOCKET_EVENTS.BRANCH_SUPERVISOR_REMOVED,
      SOCKET_EVENTS.BRANCH_DELETED,
    ],
    [['branches'], ['branch']],
  );
}
```

This makes *other* logged-in sessions' branch lists drop the deleted branch automatically when they receive the socket event — the initiating session's own redirect (Task 8) handles that session directly.

- [ ] **Step 3: Type-check the web app**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/hooks/queries/use-branches.ts
git commit -m "feat(branches): add useDeleteBranch hook and realtime sync for branch deletion"
```

---

## Task 7: `DeleteBranchDialog` component

**Files:**
- Create: `apps/web/components/admin/branches/delete-branch-dialog.tsx`

**Interfaces:**
- Consumes: `useDeleteBranch` (Task 6), `BranchResponse` type (`@potato-corner/shared`), existing `Dialog`/`Input`/`Label`/`Button` UI primitives (same imports as `edit-branch-dialog.tsx` / `change-status-dialog.tsx`).
- Produces: `DeleteBranchDialog({ open, onOpenChange, branch }: { open: boolean; onOpenChange: (open: boolean) => void; branch: BranchResponse })` — Task 8 renders this exact component with these exact prop names.

- [ ] **Step 1: Write the component**

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { BranchResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useDeleteBranch } from '@/hooks/queries/use-branches';

interface DeleteBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: BranchResponse;
}

const DELETE_KEYWORD = 'DELETE';

/** Two-field confirmation (branch name + literal "DELETE") for the cascading hard-delete action. */
export function DeleteBranchDialog({ open, onOpenChange, branch }: DeleteBranchDialogProps) {
  const router = useRouter();
  const deleteBranch = useDeleteBranch(branch.id);
  const [confirmName, setConfirmName] = useState('');
  const [confirmKeyword, setConfirmKeyword] = useState('');

  const canDelete = confirmName.trim() === branch.name && confirmKeyword.trim() === DELETE_KEYWORD;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setConfirmName('');
      setConfirmKeyword('');
    }
    onOpenChange(next);
  }

  async function handleDelete() {
    await deleteBranch.mutateAsync();
    handleOpenChange(false);
    router.push('/admin/branches');
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Permanently delete this branch?</DialogTitle>
          <DialogDescription>
            This destroys all of this branch&apos;s transactions, shifts, inventory, expenses, and attendance
            records. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>There is no way to recover this branch or its data once deleted.</span>
        </div>

        <div className="space-y-2">
          <Label htmlFor="delete-confirm-name">
            Type <span className="font-semibold">{branch.name}</span> to confirm
          </Label>
          <Input
            id="delete-confirm-name"
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            placeholder={branch.name}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="delete-confirm-keyword">
            Type <span className="font-semibold">{DELETE_KEYWORD}</span> to confirm
          </Label>
          <Input
            id="delete-confirm-keyword"
            value={confirmKeyword}
            onChange={(event) => setConfirmKeyword(event.target.value)}
            placeholder={DELETE_KEYWORD}
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={!canDelete || deleteBranch.isPending}
            onClick={() => void handleDelete()}
          >
            {deleteBranch.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Permanently Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Type-check the web app**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no new errors. (This component has no unit test file of its own — none of the other dialog components in this directory (`edit-branch-dialog.tsx`, `change-status-dialog.tsx`) have one either; coverage for this component comes from the e2e test in Task 9, matching existing project convention.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/admin/branches/delete-branch-dialog.tsx
git commit -m "feat(branches): add DeleteBranchDialog component"
```

---

## Task 8: Wire into the branch Settings tab

**Files:**
- Modify: `apps/web/app/(admin)/admin/branches/[branchId]/page.tsx`

**Interfaces:**
- Consumes: `DeleteBranchDialog` (Task 7).

- [ ] **Step 1: Add the import**

In `apps/web/app/(admin)/admin/branches/[branchId]/page.tsx`, find:
```typescript
import { EditBranchDialog } from '@/components/admin/branches/edit-branch-dialog';
import { ChangeStatusDialog } from '@/components/admin/branches/change-status-dialog';
import { AssignSupervisorDialog } from '@/components/admin/branches/assign-supervisor-dialog';
```
Change to:
```typescript
import { EditBranchDialog } from '@/components/admin/branches/edit-branch-dialog';
import { ChangeStatusDialog } from '@/components/admin/branches/change-status-dialog';
import { AssignSupervisorDialog } from '@/components/admin/branches/assign-supervisor-dialog';
import { DeleteBranchDialog } from '@/components/admin/branches/delete-branch-dialog';
```

- [ ] **Step 2: Add dialog open state**

Find:
```typescript
  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
```
Change to:
```typescript
  const [editOpen, setEditOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
```

- [ ] **Step 3: Pass the open handler down to `SettingsTab`**

Find:
```typescript
        <TabsContent value="settings" className="space-y-4">
          <SettingsTab branch={branch} onEdit={() => setEditOpen(true)} onChangeStatus={() => setStatusOpen(true)} />
        </TabsContent>
```
Change to:
```typescript
        <TabsContent value="settings" className="space-y-4">
          <SettingsTab
            branch={branch}
            onEdit={() => setEditOpen(true)}
            onChangeStatus={() => setStatusOpen(true)}
            onDelete={() => setDeleteOpen(true)}
          />
        </TabsContent>
```

- [ ] **Step 4: Render the new dialog**

Find:
```typescript
      <EditBranchDialog open={editOpen} onOpenChange={setEditOpen} branch={branch} />
      <ChangeStatusDialog open={statusOpen} onOpenChange={setStatusOpen} branch={branch} />
      <AssignSupervisorDialog open={assignOpen} onOpenChange={setAssignOpen} branchId={branchId} />
```
Change to:
```typescript
      <EditBranchDialog open={editOpen} onOpenChange={setEditOpen} branch={branch} />
      <ChangeStatusDialog open={statusOpen} onOpenChange={setStatusOpen} branch={branch} />
      <AssignSupervisorDialog open={assignOpen} onOpenChange={setAssignOpen} branchId={branchId} />
      <DeleteBranchDialog open={deleteOpen} onOpenChange={setDeleteOpen} branch={branch} />
```

- [ ] **Step 5: Update `SettingsTab`'s props type and add the Danger Zone button**

Find:
```typescript
function SettingsTab({
  branch,
  onEdit,
  onChangeStatus,
}: {
  branch: { id: string; name: string; status: string; gcashQrUrl: string | null };
  onEdit: () => void;
  onChangeStatus: () => void;
}) {
```
Change to:
```typescript
function SettingsTab({
  branch,
  onEdit,
  onChangeStatus,
  onDelete,
}: {
  branch: { id: string; name: string; status: string; gcashQrUrl: string | null };
  onEdit: () => void;
  onChangeStatus: () => void;
  onDelete: () => void;
}) {
```

Find (the end of the Danger Zone card):
```typescript
          <Button
            variant="danger"
            disabled={!canClose || changeStatus.isPending}
            onClick={() => void changeStatus.mutateAsync({ status: 'closed' })}
          >
            {branch.status === 'closed' ? 'Branch is closed' : 'Close Branch'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
```
Change to:
```typescript
          <Button
            variant="danger"
            disabled={!canClose || changeStatus.isPending}
            onClick={() => void changeStatus.mutateAsync({ status: 'closed' })}
          >
            {branch.status === 'closed' ? 'Branch is closed' : 'Close Branch'}
          </Button>

          <div className="border-t pt-3">
            <p className="mb-2 text-sm text-muted-foreground">
              Permanently delete this branch and all of its data — transactions, shifts, inventory, expenses,
              and attendance records. This cannot be undone.
            </p>
            <Button variant="danger" onClick={onDelete}>
              Permanently Delete Branch
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 6: Type-check the web app**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Manual smoke check**

Start the dev server (`cd apps/web && npm run dev` in one terminal, `cd apps/api && npm run dev` in another — check each `package.json` for the exact script name if different) and, logged in as the seeded super_admin, open a branch's Settings tab. Confirm:
- The new "Permanently Delete Branch" button appears below "Close Branch", separated by a divider.
- Clicking it opens the dialog with two empty text fields.
- The "Permanently Delete" button stays disabled until both fields are typed exactly right.
- Cancel closes the dialog without calling the API (check the Network tab — no DELETE request fires).

This is a real click-through against the running dev app, not just a type-check — do this before moving to Task 9's automated version of the same flow.

- [ ] **Step 8: Commit**

```bash
git add "apps/web/app/(admin)/admin/branches/[branchId]/page.tsx"
git commit -m "feat(branches): wire Permanently Delete Branch into the Danger Zone"
```

---

## Task 9: E2E test

**Files:**
- Modify: `tests/e2e/branch-management.spec.ts`

**Interfaces:**
- Consumes: existing `apiLogin`/`authedPost`/`authedGet` helpers (`./fixtures/api-helpers`), `TEST_USERS` (`./fixtures/test-users`) — same as the existing tests in this file.

- [ ] **Step 1: Write the test**

Add to `tests/e2e/branch-management.spec.ts`, after the closing `});` of the existing `test.describe('Branch status change guarded by active shifts (admin UI)', ...)` block, at the end of the file:

```typescript
test.describe('Permanent branch delete (admin UI)', () => {
  test('delete button stays disabled until both confirmation fields match, then deletes and redirects to the branch list', async ({
    page,
    request,
    baseURL,
  }) => {
    const url = baseURL ?? 'http://localhost:3000';
    const branchName = uniqueBranchName('DELETE');
    let branchId = '';

    await test.step('seed a throwaway branch via the real API', async () => {
      const admin = await apiLogin(
        request,
        TEST_USERS.super_admin.email,
        TEST_USERS.super_admin.password,
      );
      const created = await authedPost<{ id: string }>(
        request,
        url,
        '/api/branches',
        admin.accessToken,
        { name: branchName, address: '1 Session Road', city: 'Baguio', status: 'active' },
      );
      if (!created.data?.id)
        throw new Error(`Failed to seed branch: ${JSON.stringify(created.error)}`);
      branchId = created.data.id;
    });

    await test.step('login as super_admin and open the seeded branch settings', async () => {
      await page.goto('/login', { waitUntil: 'networkidle' });
      await page.getByLabel('Email').fill(TEST_USERS.super_admin.email);
      await page.getByRole('textbox', { name: 'Password' }).fill(TEST_USERS.super_admin.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL('**/admin/dashboard', { timeout: NAV_TIMEOUT });

      await page.goto(`/admin/branches/${branchId}`, { waitUntil: 'networkidle' });
      await page.getByRole('tab', { name: 'Settings' }).click();
    });

    await test.step('the delete button is disabled until both fields are typed exactly right', async () => {
      await page.getByRole('button', { name: 'Permanently Delete Branch' }).click();

      const dialog = page.getByRole('dialog', { name: 'Permanently delete this branch?' });
      const deleteButton = dialog.getByRole('button', { name: 'Permanently Delete' });
      await expect(deleteButton).toBeDisabled();

      await dialog.getByLabel(new RegExp(`Type ${branchName} to confirm`)).fill(branchName);
      await expect(deleteButton).toBeDisabled();

      await dialog.getByLabel('Type DELETE to confirm').fill('not delete');
      await expect(deleteButton).toBeDisabled();

      await dialog.getByLabel('Type DELETE to confirm').fill('');
      await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
      await expect(deleteButton).toBeEnabled();
    });

    await test.step('confirming deletes the branch and redirects to the branch list', async () => {
      const dialog = page.getByRole('dialog', { name: 'Permanently delete this branch?' });
      await dialog.getByRole('button', { name: 'Permanently Delete' }).click();

      await page.waitForURL('**/admin/branches', { timeout: NAV_TIMEOUT });

      const getResponse = await authedGet(
        request,
        `/api/branches/${branchId}`,
        (await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password))
          .accessToken,
      );
      expect(getResponse.status).toBe(404);
    });
  });
});
```

- [ ] **Step 2: Confirm this test is authored, not executed, per this file's existing header comment**

This file's header (lines 1–17) explicitly documents that these tests are "AUTHORED, NOT EXECUTED: no local Postgres/Redis instance is available in the environment this was written in ... never run against a live app without first confirming the seeded fixtures ... are present." Follow the same convention: do not attempt to run this against the linked Supabase project. If a real Playwright run is wanted later, that's a separate, explicit decision the project already gates behind confirming seeded fixtures exist — same caveat as every other test in this file.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/branch-management.spec.ts
git commit -m "test(branches): add e2e coverage for permanent branch delete"
```

---

## Task 10: Apply the migration to the real database — GATED, requires explicit go-ahead

**Files:** none (this task runs commands, it doesn't edit files)

This task is separated from Task 1 deliberately and must not be run automatically as part of executing this plan. Applying DDL to the actual database is a different class of action than every other task here — Tasks 1–9 only ever touch local files and Vitest's mocked Prisma client.

- [ ] **Step 1: Verify which database `DIRECT_URL` actually points at, right before running anything**

Run (from `apps/api/`): a command that prints the *host* of `DIRECT_URL` without printing the password — e.g. `node -e "console.log(new URL(process.env.DIRECT_URL).host)"` after loading the environment the same way the app does, or simply open `apps/api/.env` and read the `DIRECT_URL` line's host portion by eye. Do not paste the full connection string (with password) into a terminal command whose output you intend to keep or log.

Cross-check the host/project-ref against `supabase/.temp/project-ref` (`nliuhztaezaujzgtsrwp` as of this session) and confirm with the user which project this is meant to hit — per the project's Database & Migration Safety rule, this exact confirm-before-migrate step exists because skipping it once already produced a phantom migration against production (Phase 18 incident, documented in project CLAUDE.md).

- [ ] **Step 2: Get explicit user go-ahead for this specific step**

State plainly what is about to happen (a schema migration that changes ~20 foreign key referential actions from Restrict to Cascade on the live linked database) and wait for confirmation before running Step 3. This is a separate confirmation from whatever earlier approval covered writing the code — a code review approval is not a production-migration approval.

- [ ] **Step 3: Apply the migration**

Run: `cd apps/api && npx prisma migrate deploy`
Expected: output listing `20260725190000_branch_permanent_delete_cascade` as applied, with no errors. `migrate deploy` (not `migrate dev`) is used here deliberately — it applies pending migrations exactly as written without attempting to generate a new diff, which matches having hand-authored the SQL in Task 1.

- [ ] **Step 4: Verify in the database**

Run a read-only check that the constraints actually changed, e.g. via `psql` or the Supabase SQL editor:
```sql
SELECT conname, confdeltype FROM pg_constraint WHERE conname = 'transactions_branch_id_fkey';
```
Expected: `confdeltype` is `c` (cascade), not `r` (restrict/no action).

- [ ] **Step 5: Commit is not needed here** — the migration file was already committed in Task 1. This task only applies it.
