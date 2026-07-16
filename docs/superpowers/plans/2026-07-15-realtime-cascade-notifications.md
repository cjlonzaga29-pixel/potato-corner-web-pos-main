# Real-Time Notification Wiring + Out-of-Stock Cascade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire missing Socket.io notifications into void/refund/cash-variance flows, implement the Out-of-Stock Cascade (architecture doc §7.2), add a socket connection-status store, remove dead client-side room-join calls, and add real-time cache invalidation hooks for branches/product-requests/price-overrides, matching the invalidation pattern already used by transactions/inventory.

**Architecture:** Additive changes to existing modules — no new Express routes, no schema changes. The cascade reuses the existing branch-scoped `branch_flavor_availability` / `branch_product_availability` tables (already in schema.prisma) rather than inventing new fields. All new repository writes for the cascade run inside one `prisma.$transaction`.

**Tech Stack:** Express 5 + Prisma + BullMQ (backend), Next.js 15 + TanStack Query + Zustand + Socket.io-client v4.8 (frontend), Vitest for tests.

## Global Constraints

- TypeScript strict mode, no `any`, no `!` without a comment explaining why it's safe.
- No direct Prisma calls outside the repository layer.
- Zod schemas in `packages/shared` define every type — do not hand-roll duplicate types where a schema/interface already exists.
- Conventional commits (`feat|fix|test`, imperative mood), one commit per task.
- Socket/queue job payloads in this codebase use **camelCase** field names (see `low_stock_alert`'s payload in `notification.queue.ts` and `inventory.queue.ts`) — API HTTP responses use snake_case, but internal job/socket payloads do not. Match camelCase for every new payload in this plan.
- Do not touch `apps/web/lib/socket.ts` — see "Corrections" below, it has nothing to change.
- Quality gates (run in the final task): `pnpm --filter @potato-corner/api test`, `pnpm --filter @potato-corner/web test`, `pnpm --filter @potato-corner/api exec tsc --noEmit`, `pnpm --filter @potato-corner/web exec tsc --noEmit`, `pnpm --filter @potato-corner/shared exec tsc --noEmit`, `pnpm lint` (Turborepo `lint` task across all three packages) — all must exit 0, and no existing test may be broken.

## Corrections to the Original Request

The original request described some things that don't match this codebase's actual state. Implementing it literally would either fail to compile or silently reimplement business logic the architecture doc already locks down differently. This plan implements the **corrected** version:

1. **The Out-of-Stock Cascade algorithm is different from what was requested.** The request asked for global `ProductVariant.is_available` / `unavailable_reason`, `Product.is_available`, and `Flavor.is_available` fields. **None of these fields exist in `schema.prisma`**, and adding them would require an unrequested migration that contradicts the actual, locked algorithm already specified in `docs/architecture/final-approved-architecture.md` §7.2:
   > 1. Find all recipe rows referencing the depleted ingredient. 2. Collect distinct `flavor_id`s from those rows. 3. For each affected flavor, set `branch_flavor_availability.is_available = false`, `unavailable_reason = 'out_of_stock'`. 4. Find `product_variant_flavors` rows referencing those flavors. 5. For each affected product, check whether any other flavor remains available at the branch. 6. If zero flavors remain available, set `branch_product_availability.is_available = false`. 7. Broadcast `inventory:product_unavailable` to the branch room with the newly unavailable products/variants/flavors.

   This plan implements §7.2 literally, using the existing `BranchFlavorAvailability` and `BranchProductAvailability` tables (both already in the schema, both already used by `flavorsService`/`productsService`). Per this project's `CLAUDE.md` ("Nothing in \[the architecture docs\] is open for discussion without a formal change request — implement what they say, don't redesign it"), the doc wins over the request's invented field names.

   One resolved ambiguity: recipe rows with `flavor_id IS NULL` (base ingredients, per §7.1) apply to *every* flavor of that variant, not to a literal "null flavor" — `branch_flavor_availability` has no row for "no flavor". So a base-ingredient depletion expands to every flavor linked to that product variant via `product_variant_flavors`, each of which then gets marked unavailable. A flavor-specific recipe row marks just that flavor directly. This is stated explicitly so a reviewer isn't surprised by the expansion step.

2. **The dead `socket.emit('join', ...)` calls are not in `apps/web/lib/socket.ts`.** That file is just the `getSocket()` singleton factory — it has no room-join logic at all. The three dead calls (`socket.emit('join', 'admin')`, `socket.emit('join', branchId)` for supervisors, `socket.emit('join', branchId)` for staff) are in `apps/web/hooks/use-socket.ts`'s `handleConnect` function (lines 33–44). Server-side room assignment already happens from JWT claims on connection (`joinRoomsForUser` in `apps/api/src/socket/socket.server.ts`), confirming these calls are dead. Task 8 below removes them from `use-socket.ts`, not `lib/socket.ts`.

3. **`SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE` already exists** (`packages/shared/src/constants/events.ts:6`) — no need to add it. `TRANSACTION_REFUNDED` and a cash-variance-approval constant do **not** exist and must be added (Task 1). `VOID_APPROVED` exists but names void-approval, not cash-variance-approval — reusing it for cash variance would conflate two different domain events, so Task 1 adds `CASH_VARIANCE_APPROVED` instead, matching the existing `CASH_VARIANCE_FLAGGED` naming.

4. **No `structuredLog` utility exists** in `apps/api/src/lib/`. The cascade logging (Task 6) uses `console.info`, matching this file's existing `console.warn`/`console.error` calls — there is no structured logger to match.

5. **`socket.io-client` is v4.8.1** in this project. v4 does not emit a `'reconnecting'` event on the `Socket` itself — reconnection events live on the Manager (`socket.io`), specifically `reconnect_attempt` and `reconnect`. Task 8 listens on `socket.io.on('reconnect_attempt', ...)` / `socket.io.on('reconnect', ...)`, not a nonexistent `'reconnecting'` socket event.

6. **`cashService.approveVariance`'s socket notification only fires when `data.approved === true`.** The request didn't specify behavior for a rejection. Firing an event literally named "approved" when a supervisor's variance explanation was rejected would be misleading to any UI consuming it — the existing audit log already distinguishes `SHIFT_VARIANCE_APPROVED` vs `SHIFT_VARIANCE_REJECTED`, so the socket layer mirrors that distinction by only emitting on the approved path. Task 3 tests both branches explicitly.

7. **No dedicated repository-level or hook-level test files are added** where the codebase has no existing precedent for them: `inventory.repository.ts`, `products.repository.ts`, etc. have no `*.repository.test.ts` files anywhere in the codebase (repositories are exercised indirectly through service/queue tests with the repository mocked) — Task 4's new repository method follows that precedent and is covered by Task 6's queue test instead. Likewise, none of `use-branches.ts` / `use-product-requests.ts` / `use-price-overrides.ts` / `use-transactions.ts` / `use-inventory.ts` have existing `*.test.ts` files, so Tasks 9–13 don't add new ones (frontend query hooks aren't unit-tested in this codebase — only Zustand stores are, e.g. `auth.store.test.ts`). `notification.queue.ts` also has no existing test file and the request didn't ask for one for its one-line addition in Task 5.

---

### Task 1: Add missing SOCKET_EVENTS constants

**Files:**
- Modify: `packages/shared/src/constants/events.ts`

**Interfaces:**
- Produces: `SOCKET_EVENTS.TRANSACTION_REFUNDED` (`'transaction:refunded'`), `SOCKET_EVENTS.CASH_VARIANCE_APPROVED` (`'cash:variance_approved'`) — consumed by Tasks 2, 3, and their tests.

- [ ] **Step 1: Add the two constants**

Edit `packages/shared/src/constants/events.ts`:

```ts
/** WebSocket event name constants — shared verbatim between Socket.io server and client. */
export const SOCKET_EVENTS = {
  TRANSACTION_COMPLETED: 'transaction:completed',
  TRANSACTION_REFUNDED: 'transaction:refunded',
  INVENTORY_LOW_STOCK: 'inventory:low_stock',
  INVENTORY_OUT_OF_STOCK: 'inventory:out_of_stock',
  INVENTORY_PRODUCT_UNAVAILABLE: 'inventory:product_unavailable',
  CASH_VARIANCE_FLAGGED: 'cash:variance_flagged',
  CASH_VARIANCE_APPROVED: 'cash:variance_approved',
  // Phase 13 — shift lifecycle broadcasts; not in the original architecture
  // doc's event list (which predates the real-time layer being built out),
  // added here because openShift/closeShift had no event to wire into.
  SHIFT_OPENED: 'cash:shift_opened',
  SHIFT_CLOSED: 'cash:shift_closed',
  VOID_REQUESTED: 'void:requested',
  VOID_APPROVED: 'void:approved',
  ATTENDANCE_CLOCKED_IN: 'attendance:clocked_in',
  ATTENDANCE_CLOCKED_OUT: 'attendance:clocked_out',
  FRAUD_ALERT_CREATED: 'fraud:alert_created',
  BRANCH_STATUS_CHANGED: 'branch:status_changed',
  BRANCH_SUPERVISOR_ASSIGNED: 'branch:supervisor_assigned',
  BRANCH_SUPERVISOR_REMOVED: 'branch:supervisor_removed',

  // CR-001 — approval workflow notifications
  PRODUCT_REQUEST_SUBMITTED: 'product_request:submitted',
  PRODUCT_REQUEST_REVIEWED: 'product_request:reviewed',
  PRICE_OVERRIDE_SUBMITTED: 'price_override:submitted',
  PRICE_OVERRIDE_REVIEWED: 'price_override:reviewed',
} as const;

export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];
```

- [ ] **Step 2: Verify the shared package still type-checks and builds**

Run: `pnpm --filter @potato-corner/shared exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants/events.ts
git commit -m "feat: add TRANSACTION_REFUNDED and CASH_VARIANCE_APPROVED socket events"
```

---

### Task 2: Void/refund socket notifications in transactions.service.ts

**Files:**
- Modify: `apps/api/src/modules/transactions/transactions.service.ts`
- Test: `apps/api/src/modules/transactions/transactions.service.test.ts`

**Interfaces:**
- Consumes: `notifyBranch(branchId: string, event: string, payload: unknown): void` and `notifySuperAdmin(event: string, payload: unknown): void` from `../../lib/notify.js` (already imported in this file). `SOCKET_EVENTS.VOID_REQUESTED` (existing), `SOCKET_EVENTS.TRANSACTION_REFUNDED` (Task 1).
- Produces: no new exports — behavior-only change to `voidTransaction` and `refundTransaction`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/modules/transactions/transactions.service.test.ts`, inside the existing `describe('transactionsService.voidTransaction', ...)` block (after the existing two `it`s):

```ts
  it('broadcasts VOID_REQUESTED to the branch room and Super Admin with the void payload', async () => {
    const branchId = randomUUID();
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(
      transactionRow({ shift: { id: 'shift-1', status: 'active', branchId } }) as never,
    );
    vi.mocked(transactionsRepository.voidTransaction).mockResolvedValue(
      transactionRow({ branchId, status: 'voided', voidedById: 'admin-1', voidReason: 'customer changed mind' }) as never,
    );

    const result = await transactionsService.voidTransaction(
      'txn-1',
      'customer changed mind',
      { id: 'admin-1', role: 'super_admin' },
      null,
    );

    const expectedPayload = {
      transactionId: result.id,
      branchId: result.branch_id,
      voidedBy: 'admin-1',
      amount: result.total_amount,
      reason: result.void_reason,
    };
    expect(notifyBranch).toHaveBeenCalledWith(branchId, 'void:requested', expectedPayload);
    expect(notifySuperAdmin).toHaveBeenCalledWith('void:requested', expectedPayload);
  });
```

Add to `describe('transactionsService.refundTransaction', ...)` block:

```ts
  it('broadcasts TRANSACTION_REFUNDED to the branch room and Super Admin with the refund payload', async () => {
    const branchId = randomUUID();
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(transactionRow({ branchId }) as never);
    vi.mocked(transactionsRepository.refundTransaction).mockResolvedValue(
      transactionRow({ branchId, status: 'refunded', refundedById: 'admin-1', refundReason: 'defective' }) as never,
    );

    const result = await transactionsService.refundTransaction('txn-1', 'defective', { id: 'admin-1', role: 'super_admin' }, null);

    const expectedPayload = {
      transactionId: result.id,
      branchId: result.branch_id,
      refundedBy: 'admin-1',
      amount: result.total_amount,
    };
    expect(notifyBranch).toHaveBeenCalledWith(branchId, 'transaction:refunded', expectedPayload);
    expect(notifySuperAdmin).toHaveBeenCalledWith('transaction:refunded', expectedPayload);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/transactions/transactions.service.test.ts`
Expected: the two new tests FAIL (`notifyBranch`/`notifySuperAdmin` not called with those events); all other tests in the file still PASS.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/transactions/transactions.service.ts`, `voidTransaction` — insert before the final `return response;` (after the existing `recordAuditLog` call):

```ts
    const voidPayload = {
      transactionId: response.id,
      branchId: response.branch_id,
      voidedBy: actor.id,
      amount: response.total_amount,
      reason: response.void_reason,
    };
    notifyBranch(response.branch_id, SOCKET_EVENTS.VOID_REQUESTED, voidPayload);
    notifySuperAdmin(SOCKET_EVENTS.VOID_REQUESTED, voidPayload);

    return response;
```

`refundTransaction` — insert before its final `return response;`:

```ts
    const refundPayload = {
      transactionId: response.id,
      branchId: response.branch_id,
      refundedBy: actor.id,
      amount: response.total_amount,
    };
    notifyBranch(response.branch_id, SOCKET_EVENTS.TRANSACTION_REFUNDED, refundPayload);
    notifySuperAdmin(SOCKET_EVENTS.TRANSACTION_REFUNDED, refundPayload);

    return response;
```

(`notifyBranch`, `notifySuperAdmin`, and `SOCKET_EVENTS` are already imported at the top of the file — no import changes needed.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/transactions/transactions.service.test.ts`
Expected: all tests PASS, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/transactions/transactions.service.ts apps/api/src/modules/transactions/transactions.service.test.ts
git commit -m "feat: broadcast void and refund events from transactionsService"
```

---

### Task 3: Cash variance socket notifications in cash.service.ts

**Files:**
- Modify: `apps/api/src/modules/cash/cash.service.ts`
- Test: `apps/api/src/modules/cash/cash.service.test.ts`

**Interfaces:**
- Consumes: `notifyBranch`/`notifySuperAdmin` (already imported), `SOCKET_EVENTS.CASH_VARIANCE_FLAGGED` (existing), `SOCKET_EVENTS.CASH_VARIANCE_APPROVED` (Task 1).
- Produces: no new exports — behavior-only change to `closeShift` and `approveVariance`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/modules/cash/cash.service.test.ts`, inside `describe('cashService.closeShift', ...)`:

```ts
  it('broadcasts CASH_VARIANCE_FLAGGED to the branch room and Super Admin when the shift is flagged', async () => {
    const branchId = randomUUID();
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ branchId, openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0, gcashSalesCount: 0, voidedCount: 0, refundedCount: 0,
      totalTransactionCount: 0, totalDiscountAmount: 0, pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) =>
      Promise.resolve(asShiftRow({ ...computed, branchId, status: 'flagged' }) as never),
    );

    await cashService.closeShift(
      'shift-1',
      { denominations: [{ denomination: 500, quantity: 1 }], varianceExplanation: 'x'.repeat(50) },
      SUPERVISOR,
      null,
    );

    expect(notifyBranch).toHaveBeenCalledWith(
      branchId,
      'cash:variance_flagged',
      expect.objectContaining({ shiftId: 'shift-1', branchId, flaggedBy: SUPERVISOR.id }),
    );
    expect(notifySuperAdmin).toHaveBeenCalledWith('cash:variance_flagged', expect.objectContaining({ shiftId: 'shift-1' }));
  });

  it('does not broadcast CASH_VARIANCE_FLAGGED when the shift closes cleanly (no variance)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0, gcashSalesCount: 0, voidedCount: 0, refundedCount: 0,
      totalTransactionCount: 0, totalDiscountAmount: 0, pwdScTransactionCount: 0,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) => Promise.resolve(asShiftRow(computed) as never));

    await cashService.closeShift('shift-1', { denominations: [{ denomination: 1000, quantity: 1 }] }, SUPERVISOR, null);

    expect(notifyBranch).not.toHaveBeenCalledWith(expect.anything(), 'cash:variance_flagged', expect.anything());
  });
```

Add to `describe('cashService.approveVariance', ...)`:

```ts
  it('broadcasts CASH_VARIANCE_APPROVED to the branch room and Super Admin when approved', async () => {
    const branchId = randomUUID();
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ branchId, status: 'flagged', cashVariance: decimal(-50) }) as never);
    vi.mocked(cashRepository.approveVariance).mockResolvedValue(
      shiftRow({ branchId, status: 'closed', varianceApproved: true, cashVariance: decimal(-50) }) as never,
    );

    await cashService.approveVariance('shift-1', { approved: true, notes: 'x'.repeat(50) }, SUPER_ADMIN, null);

    expect(notifyBranch).toHaveBeenCalledWith(
      branchId,
      'cash:variance_approved',
      expect.objectContaining({ shiftId: 'shift-1', branchId, approvedBy: SUPER_ADMIN.id, variance: -50 }),
    );
    expect(notifySuperAdmin).toHaveBeenCalledWith('cash:variance_approved', expect.objectContaining({ shiftId: 'shift-1' }));
  });

  it('does not broadcast CASH_VARIANCE_APPROVED when the variance is rejected', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'flagged' }) as never);
    vi.mocked(cashRepository.approveVariance).mockResolvedValue(shiftRow({ status: 'flagged', varianceApproved: false }) as never);

    await cashService.approveVariance('shift-1', { approved: false, notes: 'x'.repeat(50) }, SUPER_ADMIN, null);

    expect(notifyBranch).not.toHaveBeenCalledWith(expect.anything(), 'cash:variance_approved', expect.anything());
    expect(notifySuperAdmin).not.toHaveBeenCalledWith('cash:variance_approved', expect.anything());
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/cash/cash.service.test.ts`
Expected: the four new tests FAIL; all pre-existing tests still PASS.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/cash/cash.service.ts`, `closeShift` — insert right after the existing `notifySuperAdmin(SOCKET_EVENTS.SHIFT_CLOSED, responseWithSummary);` line and before `return responseWithSummary;`:

```ts
    if (status === 'flagged') {
      const variancePayload = {
        shiftId: id,
        branchId: shift.branchId,
        expectedAmount: expectedClosingCash.toNumber(),
        actualAmount: closingCashAmount,
        variance: cashVariance.toNumber(),
        flaggedBy: actor.id,
      };
      notifyBranch(shift.branchId, SOCKET_EVENTS.CASH_VARIANCE_FLAGGED, variancePayload);
      notifySuperAdmin(SOCKET_EVENTS.CASH_VARIANCE_FLAGGED, variancePayload);
    }

    return responseWithSummary;
```

`approveVariance` — insert before its final `return response;`:

```ts
    if (data.approved) {
      const approvalPayload = {
        shiftId: id,
        branchId: shift.branchId,
        approvedBy: actor.id,
        variance: updated.cashVariance?.toNumber() ?? null,
      };
      notifyBranch(shift.branchId, SOCKET_EVENTS.CASH_VARIANCE_APPROVED, approvalPayload);
      notifySuperAdmin(SOCKET_EVENTS.CASH_VARIANCE_APPROVED, approvalPayload);
    }

    return response;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @potato-corner/api exec vitest run src/modules/cash/cash.service.test.ts`
Expected: all tests PASS, including the four new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/cash/cash.service.ts apps/api/src/modules/cash/cash.service.test.ts
git commit -m "feat: broadcast cash variance flagged/approved events from cashService"
```

---

### Task 4: Out-of-Stock Cascade repository method

**Files:**
- Modify: `apps/api/src/modules/inventory/inventory.repository.ts`

**Interfaces:**
- Produces: `inventoryRepository.runOutOfStockCascade(branchId: string, ingredientId: string): Promise<OutOfStockCascadeResult>`, and exported types `CascadeAffectedFlavor`, `CascadeAffectedProduct`, `OutOfStockCascadeResult` — consumed by Task 6 (`inventory.queue.ts` and its test, where this method is mocked).
  ```ts
  export interface CascadeAffectedFlavor { flavorId: string; flavorName: string }
  export interface CascadeAffectedProduct { productId: string; productName: string }
  export interface OutOfStockCascadeResult {
    affectedFlavors: CascadeAffectedFlavor[];
    affectedProducts: CascadeAffectedProduct[];
  }
  ```

No test file for this task — see "Corrections" item 7 (repositories aren't unit-tested in this codebase; Task 6 exercises this method's contract via a mock).

- [ ] **Step 1: Implement `runOutOfStockCascade`**

Add to `apps/api/src/modules/inventory/inventory.repository.ts`, above the `inventoryRepository` export object (as a standalone exported interface block) and as a new method inside the object:

```ts
export interface CascadeAffectedFlavor {
  flavorId: string;
  flavorName: string;
}

export interface CascadeAffectedProduct {
  productId: string;
  productName: string;
}

export interface OutOfStockCascadeResult {
  affectedFlavors: CascadeAffectedFlavor[];
  affectedProducts: CascadeAffectedProduct[];
}
```

Add this method inside the `inventoryRepository` object (after `hasMovementForReference`, before `findMovements`):

```ts
  /**
   * Architecture doc §7.2 Out-of-Stock Cascade. Runs only when an
   * ingredient's stock has reached zero (caller's responsibility to check).
   * flavor_id IS NULL recipe/override rows are base ingredients (§7.1) —
   * they apply to every flavor of that variant, not to a literal "null
   * flavor" (branch_flavor_availability has no such row), so they're
   * expanded to every flavor linked to the variant via product_variant_flavors
   * before being cascaded. Idempotent: a flavor/product already marked
   * unavailable is skipped, both to avoid redundant writes and so the
   * caller's "affected" result — and therefore the socket broadcast — never
   * repeats something already broadcast by an earlier deduction. Runs
   * entirely inside one transaction: either the whole cascade commits, or
   * none of it does.
   */
  async runOutOfStockCascade(branchId: string, ingredientId: string): Promise<OutOfStockCascadeResult> {
    return prisma.$transaction(async (tx) => {
      const [masterRows, overrideRows] = await Promise.all([
        tx.recipe.findMany({ where: { ingredientId, deletedAt: null }, select: { productVariantId: true, flavorId: true } }),
        tx.branchRecipeOverride.findMany({
          where: { ingredientId, branchId, deletedAt: null },
          select: { productVariantId: true, flavorId: true },
        }),
      ]);
      const rows = [...masterRows, ...overrideRows];
      if (rows.length === 0) return { affectedFlavors: [], affectedProducts: [] };

      const baseVariantIds = [...new Set(rows.filter((r) => r.flavorId === null).map((r) => r.productVariantId))];
      const directFlavorIds = new Set(rows.filter((r) => r.flavorId !== null).map((r) => r.flavorId as string));

      if (baseVariantIds.length > 0) {
        const expanded = await tx.productVariantFlavor.findMany({
          where: { productVariantId: { in: baseVariantIds } },
          select: { flavorId: true },
        });
        for (const row of expanded) directFlavorIds.add(row.flavorId);
      }

      if (directFlavorIds.size === 0) return { affectedFlavors: [], affectedProducts: [] };

      const existingAvailability = await tx.branchFlavorAvailability.findMany({
        where: { branchId, flavorId: { in: [...directFlavorIds] } },
        select: { flavorId: true, isAvailable: true },
      });
      const alreadyUnavailable = new Set(existingAvailability.filter((r) => !r.isAvailable).map((r) => r.flavorId));
      const flavorIdsToDisable = [...directFlavorIds].filter((id) => !alreadyUnavailable.has(id));

      if (flavorIdsToDisable.length === 0) return { affectedFlavors: [], affectedProducts: [] };

      const flavors = await tx.flavor.findMany({ where: { id: { in: flavorIdsToDisable } }, select: { id: true, name: true } });

      for (const flavorId of flavorIdsToDisable) {
        await tx.branchFlavorAvailability.upsert({
          where: { branchId_flavorId: { branchId, flavorId } },
          create: { branchId, flavorId, isAvailable: false, unavailableReason: 'out_of_stock' },
          update: { isAvailable: false, unavailableReason: 'out_of_stock' },
        });
      }

      const linkedVariantFlavors = await tx.productVariantFlavor.findMany({
        where: { flavorId: { in: flavorIdsToDisable } },
        select: { productVariant: { select: { productId: true } } },
      });
      const candidateProductIds = [...new Set(linkedVariantFlavors.map((r) => r.productVariant.productId))];

      const affectedProducts: CascadeAffectedProduct[] = [];
      for (const productId of candidateProductIds) {
        const productFlavorLinks = await tx.productVariantFlavor.findMany({
          where: { productVariant: { productId } },
          select: { flavorId: true },
        });
        const distinctFlavorIds = [...new Set(productFlavorLinks.map((r) => r.flavorId))];

        const unavailableForProduct = await tx.branchFlavorAvailability.findMany({
          where: { branchId, flavorId: { in: distinctFlavorIds }, isAvailable: false },
          select: { flavorId: true },
        });
        const unavailableSet = new Set(unavailableForProduct.map((r) => r.flavorId));
        const anyFlavorStillAvailable = distinctFlavorIds.some((id) => !unavailableSet.has(id));
        if (anyFlavorStillAvailable) continue;

        const existingProductAvailability = await tx.branchProductAvailability.findUnique({
          where: { branchId_productId: { branchId, productId } },
        });
        if (existingProductAvailability?.isAvailable === false) continue;

        await tx.branchProductAvailability.upsert({
          where: { branchId_productId: { branchId, productId } },
          create: { branchId, productId, isAvailable: false },
          update: { isAvailable: false },
        });

        const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true, name: true } });
        if (product) affectedProducts.push({ productId: product.id, productName: product.name });
      }

      return {
        affectedFlavors: flavors.map((f) => ({ flavorId: f.id, flavorName: f.name })),
        affectedProducts,
      };
    });
  },
```

- [ ] **Step 2: Verify the API package type-checks**

Run: `pnpm --filter @potato-corner/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/inventory/inventory.repository.ts
git commit -m "feat: add Out-of-Stock Cascade repository method (architecture doc §7.2)"
```

---

### Task 5: notification.queue.ts — stub handler for inventory_product_unavailable

**Files:**
- Modify: `apps/api/src/queues/notification.queue.ts`

**Interfaces:**
- Consumes: nothing new (this handler just logs; the real-time emit happens directly in `inventory.queue.ts`, Task 6 — matching the existing note in this file about `inventory_deduction_failed` doing the same thing for a different reason).

No test file — see "Corrections" item 7.

- [ ] **Step 1: Implement**

In `apps/api/src/queues/notification.queue.ts`, add a new interface near the existing `InventoryDeductionFailedJobData`:

```ts
interface InventoryProductUnavailableJobData {
  branchId: string;
  triggeredByIngredientId: string;
  triggeredByIngredientName: string;
  affectedFlavors: { flavorId: string; name: string }[];
  affectedProducts: { productId: string; name: string }[];
}
```

Add a new branch inside the worker's job handler, after the existing `inventory_deduction_failed` branch and before the `// TODO(Phase 8+)` comment:

```ts
    if (job.name === 'inventory_product_unavailable') {
      const data = job.data as InventoryProductUnavailableJobData;
      // The branch/super-admin socket broadcast already happened directly
      // from the inventory worker (queues/inventory.queue.ts) at cascade
      // time — this job exists so a future notification channel (push,
      // email — Phase 18) has a durable job to hang off, same reasoning as
      // inventory_deduction_failed above. TODO(Phase 18): send push/email.
      console.info(
        `Out-of-stock cascade at branch ${data.branchId}: ${data.affectedFlavors.length} flavor(s), ${data.affectedProducts.length} product(s) marked unavailable (triggered by ${data.triggeredByIngredientName})`,
      );
      return;
    }
```

- [ ] **Step 2: Verify the API package type-checks**

Run: `pnpm --filter @potato-corner/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/queues/notification.queue.ts
git commit -m "feat: add inventory_product_unavailable stub handler to notification queue"
```

---

### Task 6: Wire the cascade into processSaleDeduction + broadcast

**Files:**
- Modify: `apps/api/src/queues/inventory.queue.ts`
- Test: `apps/api/src/queues/inventory.queue.test.ts`

**Interfaces:**
- Consumes: `inventoryRepository.runOutOfStockCascade` (Task 4), `notifyBranch`/`notifySuperAdmin` from `../lib/notify.js`, `SOCKET_EVENTS` from `@potato-corner/shared`, `notificationQueue.add('inventory_product_unavailable', ...)` (Task 5's job type).
- Produces: no new exports — behavior-only change to `processSaleDeduction`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/queues/inventory.queue.test.ts`. First, extend the two mocks at the top of the file:

```ts
vi.mock('../modules/inventory/inventory.repository.js', () => ({
  inventoryRepository: {
    findIngredientById: vi.fn(),
    appendMovement: vi.fn(),
    hasMovementForReference: vi.fn(),
    updateTransactionDeductionStatus: vi.fn(),
    runOutOfStockCascade: vi.fn(),
  },
}));
```

Add a new mock block (with the others near the top):

```ts
vi.mock('../lib/notify.js', () => ({
  notifyBranch: vi.fn(),
  notifySuperAdmin: vi.fn(),
}));
```

Add the new import alongside the existing ones:

```ts
const { notifyBranch, notifySuperAdmin } = await import('../lib/notify.js');
```

Set the cascade mock's default (no-op) resolution in `beforeEach`, alongside the existing defaults:

```ts
  vi.mocked(inventoryRepository.runOutOfStockCascade).mockResolvedValue({ affectedFlavors: [], affectedProducts: [] });
```

Add a new `describe` block at the end of the file:

```ts
describe('processSaleDeduction — Out-of-Stock Cascade', () => {
  it('runs the cascade when post-deduction stock reaches exactly zero', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([deductionLine({ quantity: 50 })] as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(0) }) as never);
    vi.mocked(inventoryRepository.runOutOfStockCascade).mockResolvedValue({
      affectedFlavors: [{ flavorId: 'flavor-1', flavorName: 'Sour Cream' }],
      affectedProducts: [{ productId: 'product-1', productName: 'Potato Corner Fries' }],
    });

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    });

    await processSaleDeduction(job);

    expect(inventoryRepository.runOutOfStockCascade).toHaveBeenCalledWith('branch-1', 'ing-1');
  });

  it('broadcasts INVENTORY_PRODUCT_UNAVAILABLE to the branch room and Super Admin when the cascade affects flavors or products', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([deductionLine({ quantity: 50 })] as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(0) }) as never);
    vi.mocked(inventoryRepository.runOutOfStockCascade).mockResolvedValue({
      affectedFlavors: [{ flavorId: 'flavor-1', flavorName: 'Sour Cream' }],
      affectedProducts: [{ productId: 'product-1', productName: 'Potato Corner Fries' }],
    });

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    });

    await processSaleDeduction(job);

    const expectedPayload = {
      branchId: 'branch-1',
      triggeredByIngredientId: 'ing-1',
      triggeredByIngredientName: 'Potato',
      affectedFlavors: [{ flavorId: 'flavor-1', name: 'Sour Cream' }],
      affectedProducts: [{ productId: 'product-1', name: 'Potato Corner Fries' }],
    };
    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'inventory:product_unavailable', expectedPayload);
    expect(notifySuperAdmin).toHaveBeenCalledWith('inventory:product_unavailable', expectedPayload);
    expect(notificationQueue.add).toHaveBeenCalledWith('inventory_product_unavailable', expectedPayload);
  });

  it('does not broadcast when the cascade affects nothing (idempotent retry)', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([deductionLine({ quantity: 50 })] as never);
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(0) }) as never);
    vi.mocked(inventoryRepository.runOutOfStockCascade).mockResolvedValue({ affectedFlavors: [], affectedProducts: [] });

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    });

    await processSaleDeduction(job);

    expect(notifyBranch).not.toHaveBeenCalledWith(expect.anything(), 'inventory:product_unavailable', expect.anything());
    expect(notifySuperAdmin).not.toHaveBeenCalledWith('inventory:product_unavailable', expect.anything());
  });

  it('does not run the cascade when stock is low but not zero', async () => {
    vi.mocked(computeDeduction).mockResolvedValueOnce([deductionLine({ quantity: 42 })] as never);
    vi.mocked(inventoryRepository.findIngredientById).mockResolvedValue(
      ingredientRow({ lowStockThreshold: decimal(10), criticalThreshold: decimal(5) }) as never,
    );
    vi.mocked(inventoryRepository.appendMovement).mockResolvedValue(movementRow({ quantityAfter: decimal(8) }) as never);

    const job = fakeJob({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    });

    await processSaleDeduction(job);

    expect(inventoryRepository.runOutOfStockCascade).not.toHaveBeenCalled();
    // The existing low-stock alert still fires — the cascade is additive, not a replacement.
    expect(notificationQueue.add).toHaveBeenCalledWith('low_stock_alert', expect.objectContaining({ severity: 'low' }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @potato-corner/api exec vitest run src/queues/inventory.queue.test.ts`
Expected: the four new cascade tests FAIL (`runOutOfStockCascade` doesn't exist on the real code path yet); all pre-existing tests in this file still PASS.

- [ ] **Step 3: Implement**

In `apps/api/src/queues/inventory.queue.ts`, update the imports at the top:

```ts
import { Queue, Worker, type Job } from 'bullmq';
import { MOVEMENT_TYPE, INVENTORY_DEDUCTION_STATUS, SOCKET_EVENTS } from '@potato-corner/shared';
import { redis, createWorkerConnection } from '../lib/redis.js';
import { inventoryRepository } from '../modules/inventory/inventory.repository.js';
import { computeDeduction } from '../modules/recipes/recipes.service.js';
import { recordAuditLog } from '../middleware/audit-log.js';
import { notificationQueue } from './notification.queue.js';
import { notifyBranch, notifySuperAdmin } from '../lib/notify.js';
```

In `processSaleDeduction`, replace the low-stock-check block (currently the last block inside the `for (const [ingredientId, total] of totals)` loop, right before its closing brace) so it also runs the cascade when stock has reached zero:

```ts
    const currentStock = movement.quantityAfter.toNumber();
    const lowThreshold = ingredient.lowStockThreshold.toNumber();
    const criticalThreshold = ingredient.criticalThreshold.toNumber();
    if (currentStock <= lowThreshold) {
      await notificationQueue.add('low_stock_alert', {
        branchId,
        ingredientId,
        ingredientName: total.ingredientName,
        currentStock,
        lowStockThreshold: lowThreshold,
        criticalThreshold,
        severity: currentStock <= criticalThreshold ? 'critical' : 'low',
      });
    }

    // Architecture doc §7.2 Out-of-Stock Cascade — only once stock has
    // actually reached zero (or gone negative from a concurrent deduction),
    // never merely low/critical.
    if (currentStock <= 0) {
      const cascadeResult = await inventoryRepository.runOutOfStockCascade(branchId, ingredientId);
      console.info(
        `Out-of-stock cascade for ingredient ${ingredientId} (${total.ingredientName}) at branch ${branchId}: ${cascadeResult.affectedFlavors.length} flavor(s), ${cascadeResult.affectedProducts.length} product(s) newly unavailable`,
      );
      if (cascadeResult.affectedFlavors.length > 0 || cascadeResult.affectedProducts.length > 0) {
        const cascadePayload = {
          branchId,
          triggeredByIngredientId: ingredientId,
          triggeredByIngredientName: total.ingredientName,
          affectedFlavors: cascadeResult.affectedFlavors.map((f) => ({ flavorId: f.flavorId, name: f.flavorName })),
          affectedProducts: cascadeResult.affectedProducts.map((p) => ({ productId: p.productId, name: p.productName })),
        };
        notifyBranch(branchId, SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE, cascadePayload);
        notifySuperAdmin(SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE, cascadePayload);
        await notificationQueue.add('inventory_product_unavailable', cascadePayload);
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @potato-corner/api exec vitest run src/queues/inventory.queue.test.ts`
Expected: all tests PASS, including the four new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/queues/inventory.queue.ts apps/api/src/queues/inventory.queue.test.ts
git commit -m "feat: run Out-of-Stock Cascade and broadcast inventory:product_unavailable"
```

---

### Task 7: Socket connection-status Zustand store

**Files:**
- Create: `apps/web/stores/socket.store.ts`
- Test: `apps/web/stores/socket.store.test.ts`

**Interfaces:**
- Produces: `useSocketStore` — `{ isConnected: boolean; isReconnecting: boolean; lastConnectedAt: Date | null; setConnected: (v: boolean) => void; setReconnecting: (v: boolean) => void }`. Consumed by Task 8.

- [ ] **Step 1: Write the failing test**

Create `apps/web/stores/socket.store.test.ts`, following `auth.store.test.ts`'s pattern:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useSocketStore } from './socket.store';

beforeEach(() => {
  useSocketStore.setState({ isConnected: false, isReconnecting: false, lastConnectedAt: null });
});

describe('useSocketStore', () => {
  it('starts disconnected with no last-connected timestamp', () => {
    const state = useSocketStore.getState();
    expect(state.isConnected).toBe(false);
    expect(state.isReconnecting).toBe(false);
    expect(state.lastConnectedAt).toBeNull();
  });

  it('setConnected(true) flips isConnected', () => {
    useSocketStore.getState().setConnected(true);
    expect(useSocketStore.getState().isConnected).toBe(true);
  });

  it('setConnected(false) flips isConnected back', () => {
    useSocketStore.getState().setConnected(true);
    useSocketStore.getState().setConnected(false);
    expect(useSocketStore.getState().isConnected).toBe(false);
  });

  it('setReconnecting(true) flips isReconnecting', () => {
    useSocketStore.getState().setReconnecting(true);
    expect(useSocketStore.getState().isReconnecting).toBe(true);
  });

  it('setReconnecting(false) flips isReconnecting back', () => {
    useSocketStore.getState().setReconnecting(true);
    useSocketStore.getState().setReconnecting(false);
    expect(useSocketStore.getState().isReconnecting).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @potato-corner/web exec vitest run stores/socket.store.test.ts`
Expected: FAIL — `./socket.store` does not exist yet.

- [ ] **Step 3: Implement**

Create `apps/web/stores/socket.store.ts`:

```ts
import { create } from 'zustand';

interface SocketState {
  isConnected: boolean;
  isReconnecting: boolean;
  lastConnectedAt: Date | null;
  setConnected: (isConnected: boolean) => void;
  setReconnecting: (isReconnecting: boolean) => void;
}

/** Shared Socket.io connection status — pure state, no socket.io logic. The socket lifecycle itself lives in hooks/use-socket.ts. */
export const useSocketStore = create<SocketState>((set) => ({
  isConnected: false,
  isReconnecting: false,
  lastConnectedAt: null,
  setConnected: (isConnected) =>
    set({ isConnected, isReconnecting: false, ...(isConnected && { lastConnectedAt: new Date() }) }),
  setReconnecting: (isReconnecting) => set({ isReconnecting }),
}));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @potato-corner/web exec vitest run stores/socket.store.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/stores/socket.store.ts apps/web/stores/socket.store.test.ts
git commit -m "feat: add socket connection-status store"
```

---

### Task 8: Wire useSocketStore into use-socket.ts and remove dead room-join emits

**Files:**
- Modify: `apps/web/hooks/use-socket.ts`

**Interfaces:**
- Consumes: `useSocketStore` (Task 7).
- Produces: no signature change to `useSocket()`'s return value (`{ isConnected, socket, on, off, emit }`) — existing callers are unaffected. `isConnected` is now sourced from the store instead of local `useState`, but keeps the same type and meaning.

No test file — see "Corrections" item 7 (no existing hook tests to extend, and this hook depends on a live `Socket` instance that isn't mocked anywhere in this codebase).

- [ ] **Step 1: Implement**

Replace the full contents of `apps/web/hooks/use-socket.ts`:

```ts
'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket } from '@/lib/socket';
import { useAuthStore } from '@/stores/auth.store';
import { useSocketStore } from '@/stores/socket.store';

/**
 * Initializes the Socket.io connection for the current session. Room
 * assignment is handled server-side from JWT claims (see
 * apps/api/src/socket/socket.server.ts's joinRoomsForUser) — no client emit
 * needed. Disconnects when auth state clears (logout) and reconnects on the
 * next login.
 */
export function useSocket() {
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);
  const setConnected = useSocketStore((state) => state.setConnected);
  const setReconnecting = useSocketStore((state) => state.setReconnecting);
  const isConnected = useSocketStore((state) => state.isConnected);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!accessToken || !user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setConnected(false);
      return;
    }

    const socket = getSocket(accessToken);
    socketRef.current = socket;

    function handleConnect() {
      setConnected(true);
    }

    function handleDisconnect() {
      setConnected(false);
    }

    function handleReconnectAttempt() {
      setReconnecting(true);
    }

    function handleReconnect() {
      setReconnecting(false);
    }

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    // Reconnection events live on the Manager in socket.io-client v4, not the Socket itself.
    socket.io.on('reconnect_attempt', handleReconnectAttempt);
    socket.io.on('reconnect', handleReconnect);

    if (socket.connected) {
      handleConnect();
    } else {
      socket.connect();
    }

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
      socket.io.off('reconnect', handleReconnect);
    };
  }, [accessToken, user, setConnected, setReconnecting]);

  const on = useCallback((event: string, handler: (...args: unknown[]) => void) => {
    socketRef.current?.on(event, handler);
  }, []);

  const off = useCallback((event: string, handler: (...args: unknown[]) => void) => {
    socketRef.current?.off(event, handler);
  }, []);

  const emit = useCallback((event: string, ...args: unknown[]) => {
    socketRef.current?.emit(event, ...args);
  }, []);

  return { isConnected, socket: socketRef.current, on, off, emit };
}
```

Note what was deliberately dropped: the `ROLES` import and the three `socket.emit('join', ...)` calls inside the old `handleConnect` (admin/supervisor/staff room joins) — dead code, since the server already assigns rooms from the JWT on connection.

- [ ] **Step 2: Verify the web package type-checks**

Run: `pnpm --filter @potato-corner/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manually verify no regression**

Run: `pnpm --filter @potato-corner/web test` (runs the full existing web test suite — this hook has no dedicated test, but confirms nothing else broke, e.g. any component that imports `useSocket`).
Expected: all existing tests PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/hooks/use-socket.ts
git commit -m "refactor: remove dead client room-join emits, wire socket store into useSocket"
```

---

### Task 9: Real-time sync hook for branches

**Files:**
- Modify: `apps/web/hooks/queries/use-branches.ts`

**Interfaces:**
- Produces: `useBranchesRealtimeSync(): void` (exported), following the naming/shape of the existing `useTransactionsRealtimeSync` / `useInventoryRealtimeSync`.

No test file — see "Corrections" item 7.

- [ ] **Step 1: Implement**

In `apps/web/hooks/queries/use-branches.ts`, add to the imports:

```ts
import { SOCKET_EVENTS } from '@potato-corner/shared';
```

and:

```ts
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';
```

Add this export at the end of the file:

```ts
/** Keeps the branch list/detail views in sync with status changes and supervisor assignment changes made from any other session, without a manual refresh. */
export function useBranchesRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.BRANCH_STATUS_CHANGED, SOCKET_EVENTS.BRANCH_SUPERVISOR_ASSIGNED, SOCKET_EVENTS.BRANCH_SUPERVISOR_REMOVED],
    [['branches'], ['branch']],
  );
}
```

- [ ] **Step 2: Verify the web package type-checks**

Run: `pnpm --filter @potato-corner/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/hooks/queries/use-branches.ts
git commit -m "feat: add useBranchesRealtimeSync hook"
```

---

### Task 10: Real-time sync hook for product requests

**Files:**
- Modify: `apps/web/hooks/queries/use-product-requests.ts`

**Interfaces:**
- Produces: `useProductRequestsRealtimeSync(): void` (exported).

No test file — see "Corrections" item 7.

- [ ] **Step 1: Implement**

In `apps/web/hooks/queries/use-product-requests.ts`, add to the imports:

```ts
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';
```

Add this export at the end of the file:

```ts
/** Keeps the product-request list/detail views in sync with submissions and reviews made from any other session, without a manual refresh. */
export function useProductRequestsRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.PRODUCT_REQUEST_SUBMITTED, SOCKET_EVENTS.PRODUCT_REQUEST_REVIEWED],
    [['product-requests'], ['product-request']],
  );
}
```

- [ ] **Step 2: Verify the web package type-checks**

Run: `pnpm --filter @potato-corner/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/hooks/queries/use-product-requests.ts
git commit -m "feat: add useProductRequestsRealtimeSync hook"
```

---

### Task 11: Real-time sync hook for price overrides

**Files:**
- Modify: `apps/web/hooks/queries/use-price-overrides.ts`

**Interfaces:**
- Produces: `usePriceOverridesRealtimeSync(): void` (exported).

No test file — see "Corrections" item 7.

- [ ] **Step 1: Implement**

In `apps/web/hooks/queries/use-price-overrides.ts`, add to the imports:

```ts
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { useRealtimeInvalidate } from '@/hooks/use-realtime-invalidate';
```

Add this export at the end of the file:

```ts
/** Keeps the price-override list in sync with submissions and reviews made from any other session, without a manual refresh. usePriceOverride derives from usePriceOverrides, so a single ['price-overrides'] invalidation covers both. */
export function usePriceOverridesRealtimeSync(): void {
  useRealtimeInvalidate([SOCKET_EVENTS.PRICE_OVERRIDE_SUBMITTED, SOCKET_EVENTS.PRICE_OVERRIDE_REVIEWED], [['price-overrides']]);
}
```

- [ ] **Step 2: Verify the web package type-checks**

Run: `pnpm --filter @potato-corner/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/hooks/queries/use-price-overrides.ts
git commit -m "feat: add usePriceOverridesRealtimeSync hook"
```

---

### Task 12: Extend useTransactionsRealtimeSync with void/refund events

**Files:**
- Modify: `apps/web/hooks/queries/use-transactions.ts`

**Interfaces:**
- Modifies existing `useTransactionsRealtimeSync()` — no signature change, only its subscribed event list grows.

- [ ] **Step 1: Implement**

In `apps/web/hooks/queries/use-transactions.ts`, change:

```ts
export function useTransactionsRealtimeSync(): void {
  useRealtimeInvalidate([SOCKET_EVENTS.TRANSACTION_COMPLETED], [['transactions'], ['current-shift']]);
}
```

to:

```ts
export function useTransactionsRealtimeSync(): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.TRANSACTION_COMPLETED, SOCKET_EVENTS.VOID_REQUESTED, SOCKET_EVENTS.TRANSACTION_REFUNDED],
    [['transactions'], ['current-shift']],
  );
}
```

- [ ] **Step 2: Verify the web package type-checks**

Run: `pnpm --filter @potato-corner/web exec tsc --noEmit`
Expected: no errors (confirms `SOCKET_EVENTS.TRANSACTION_REFUNDED` from Task 1 resolves correctly).

- [ ] **Step 3: Commit**

```bash
git add apps/web/hooks/queries/use-transactions.ts
git commit -m "feat: sync transaction list on void and refund events too"
```

---

### Task 13: Extend useInventoryRealtimeSync with the cascade event

**Files:**
- Modify: `apps/web/hooks/queries/use-inventory.ts`

**Interfaces:**
- Modifies existing `useInventoryRealtimeSync()` — no signature change, only its subscribed event list grows.

- [ ] **Step 1: Implement**

In `apps/web/hooks/queries/use-inventory.ts`, change:

```ts
export function useInventoryRealtimeSync(branchId: string | null | undefined): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.INVENTORY_LOW_STOCK, SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK],
    [['ingredients', branchId], ['branch-inventory', branchId]],
  );
}
```

to:

```ts
export function useInventoryRealtimeSync(branchId: string | null | undefined): void {
  useRealtimeInvalidate(
    [SOCKET_EVENTS.INVENTORY_LOW_STOCK, SOCKET_EVENTS.INVENTORY_OUT_OF_STOCK, SOCKET_EVENTS.INVENTORY_PRODUCT_UNAVAILABLE],
    [['ingredients', branchId], ['branch-inventory', branchId]],
  );
}
```

- [ ] **Step 2: Verify the web package type-checks**

Run: `pnpm --filter @potato-corner/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/hooks/queries/use-inventory.ts
git commit -m "feat: sync inventory views on the out-of-stock cascade event too"
```

---

### Task 14: Full quality gate

**Files:** none (verification only).

- [ ] **Step 1: Run every package's test suite**

```bash
pnpm --filter @potato-corner/api test
pnpm --filter @potato-corner/web test
```
Expected: 0 failed in both — every pre-existing test still passes, plus the new tests from Tasks 2, 3, 6, 7.

- [ ] **Step 2: Type-check every package**

```bash
pnpm --filter @potato-corner/api exec tsc --noEmit
pnpm --filter @potato-corner/web exec tsc --noEmit
pnpm --filter @potato-corner/shared exec tsc --noEmit
```
Expected: 0 errors in all three.

- [ ] **Step 3: Lint everything**

```bash
pnpm lint
```
Expected: 0 errors (Turborepo fans this out to `api`, `web`, and `shared`'s own `eslint .`).

- [ ] **Step 4: Confirm no unintended files changed**

```bash
git status
git diff --stat HEAD~14..HEAD
```
Expected: only the files listed across Tasks 1–13 appear — no schema migration, no new Express routes, no changes to `apps/web/lib/socket.ts` (per Correction 2).

- [ ] **Step 5: Report**

No commit for this task — it's verification-only. If anything fails, return to the task that owns the failing file and fix it there (with its own commit), then re-run this gate.
