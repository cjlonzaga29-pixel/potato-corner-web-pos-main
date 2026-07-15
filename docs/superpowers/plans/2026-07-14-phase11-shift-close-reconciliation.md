# Phase 11 — Shift Closing & Cash Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Phase-9 shift-close flow with BIR-relevant close-time summary fields, a full EOD-summary object on close and a new read endpoint, and build the admin/supervisor shift-review UI that was left as placeholders.

**Architecture:** All new counts (`cashSalesCount`, `gcashSalesCount`, `voidedCount`, `refundedCount`, `totalTransactionCount`, `totalDiscountAmount`, `pwdScTransactionCount`) are computed once at close time from `Transaction` rows and persisted on `Shift`; a new `GET /api/cash/:shiftId/summary` endpoint computes the same shape live for an OPEN shift or reads the persisted values for a CLOSED/FLAGGED one. Frontend consumes both through two new/enhanced TanStack Query hooks and three page-level UI surfaces (`/shift/close` enhancement, `/admin/shifts` list+detail, `/supervisor/cash` build-out).

**Tech Stack:** Express + Prisma (Postgres) + Zod (`@potato-corner/shared`) on the API; Next.js App Router + TanStack Query + Zustand + shadcn/ui + TanStack Table on the web app; Vitest for all tests.

## Global Constraints

- Enum/status **values are lowercase snake_case**, matching `packages/shared/src/constants/status.ts` — `PaymentMethod` is `'cash'|'gcash'`, `TransactionStatus` is `'completed'|'voided'|'refunded'`, `DiscountType` includes `'pwd'` and `'senior_citizen'`, `ShiftStatus` is `'active'|'closed'|'flagged'`. The user's phase brief used uppercase placeholder names (`CASH`, `COMPLETED`, `PWD`, `OPEN`, `PENDING_REVIEW`) — those are **not real enum values in this codebase** and must not be introduced. `'active'` = OPEN, `'flagged'` = PENDING_REVIEW, `'closed'` = CLOSED for every UI/status mapping in this plan.
- API wire format is **snake_case** (see `toShiftResponse` in `cash.service.ts` and `shiftResponseSchema` in `packages/shared`). All new response fields follow this, not the camelCase used in the phase brief's pseudo-JSON.
- Repository layer is the only place that touches Prisma (`cash.repository.ts`). Service layer computes and calls `recordAuditLog`. Router only validates/authorizes and shapes the HTTP response.
- Every **mutating** write already produces an `AuditLog` entry via `recordAuditLog` (`apps/api/src/middleware/audit-log.ts`) — this phase adds one read endpoint (no new audit entries needed) and enhances one existing write (`closeShift`, whose audit call already exists and needs no shape change).
- No new npm packages. No hard deletes (N/A this phase — no deletes at all).
- Migration file naming: `YYYYMMDDHHMMSS_phase11_<description>`, following `apps/api/prisma/migrations/20260714150000_phase10_transactions` etc.
- All existing 311 tests must keep passing. 0 TypeScript errors (`pnpm type-check`), 0 lint errors (`pnpm lint`).

## Resolved ambiguities (flagged per the phase brief's explicit request)

1. **Response shape conflict for `POST /:shiftId/close`.** The brief asks for both "add a `summary` object to the close response" (nested under a new top-level `{ shift, summary }` wrapper) *and* "do not break the existing close endpoint contract... add to it, do not replace it." Today `data` in the close response **is** the flat shift object (`{ id, status, opening_cash_amount, ... }`), consumed directly as `ShiftResponse` by `useCloseShift` on the frontend. Wrapping it under a `shift` key would move every existing field one level deeper — a breaking change. Resolution: **`POST /:shiftId/close`'s `data` stays the flat shift object, with one new `data.summary` key added.** The brand-new `GET /:shiftId/summary` endpoint has no prior contract, so it uses the literal `{ shift, summary }` wrapper the brief describes. Both `summary` sub-objects have an identical shape.
2. **`variance_status` only has two brief-specified values** (`AUTO_APPROVED` / `PENDING_REVIEW`), but the real state machine has a third outcome once a flagged shift is resolved via `POST /:shiftId/approve-variance` (approved or rejected, both leaving `status: 'closed'`). Resolution: compute `variance_status` purely from the current `status` column — `'flagged' → PENDING_REVIEW`, anything else `→ AUTO_APPROVED`. A manually-resolved shift therefore reads as `AUTO_APPROVED` in this field; the full decision trail (`variance_approved`, `variance_approved_by`, `variance_approval_reason`) remains available on the shift object itself for anyone who needs to tell the two apart. **This means a `PENDING_REVIEW` shift never lingers once approved/rejected — it always flips to `AUTO_APPROVED`-labeled `closed` and is included in reporting from that point on.** Flag for Phase 16 (reporting): confirm whether reports should additionally surface "was this shift's variance manually resolved" — the raw fields exist today even though `variance_status` collapses them.
3. **`actual_cash`/`variance`/`variance_status` are `null` for an OPEN shift's summary** (no closing count has happened yet) — only `expected_cash` (and the sales/count fields) are live-computed for an open shift. `PENDING_REVIEW` shifts (`status: 'flagged'`) are **not blocked from appearing** in `/admin/shifts` or `GET /:shiftId/summary` — they list and render normally with an amber badge; only the reporting-inclusion question above (item 2) is deferred to Phase 16.
4. **No cashier-handover detection, variance-tolerance configurability, `cash:variance_flagged` socket event, or `cash_variance_pattern` fraud alert exist yet** (confirmed via codebase investigation, not assumed) — none of these are named in this phase's brief, so none are built here. Not a gap introduced by this plan.
5. **`GET /api/transactions` requires `branch_id` for non-super_admin callers** (via `branchGuard`). The new shift-detail transaction list passes `shift_id` **and** `branch_id` (from the loaded shift) on every request so it works for supervisors too, not just super_admin.

---

### Task 1: Prisma schema — add the 7 summary fields to `Shift`, migrate

**Files:**
- Modify: `apps/api/prisma/schema.prisma:679-717` (`Shift` model)

**Interfaces:**
- Produces: 7 new `Shift` columns, all camelCase in Prisma / snake_case in Postgres, consumed by Task 3 (repository) and Task 4 (service).

- [ ] **Step 1: Add the 7 fields to the `Shift` model**

In `apps/api/prisma/schema.prisma`, inside `model Shift { ... }`, add these fields directly after `shiftNotes String? @map("shift_notes")` (line 693) and before the relation fields:

```prisma
  cashSalesCount         Int         @default(0) @map("cash_sales_count")
  gcashSalesCount        Int         @default(0) @map("gcash_sales_count")
  voidedCount            Int         @default(0) @map("voided_count")
  refundedCount          Int         @default(0) @map("refunded_count")
  totalTransactionCount  Int         @default(0) @map("total_transaction_count")
  totalDiscountAmount    Decimal     @default(0) @map("total_discount_amount") @db.Decimal(10, 2)
  pwdScTransactionCount  Int         @default(0) @map("pwd_sc_transaction_count")
```

Note: `totalTransactionCount` (all statuses, written once at close) is **distinct** from the existing `transactionCount` field (COMPLETED-only, live-overlaid for active shifts by `withLiveSalesTotals`). Both stay — do not merge or rename either.

- [ ] **Step 2: Generate and apply the migration**

Run:
```bash
pnpm --filter @potato-corner/api prisma:migrate -- --name phase11_shift_close_summary_fields
```
Expected: creates `apps/api/prisma/migrations/20260714160000_phase11_shift_close_summary_fields/migration.sql` (timestamp will be whatever `prisma migrate dev` generates — do not hand-edit it) containing 7 `ALTER TABLE "shifts" ADD COLUMN ...` statements, applies it to the local dev DB, and regenerates the Prisma client. Confirm exit code 0 and that `apps/api/node_modules/.prisma/client` reflects the new fields (`grep -c cashSalesCount apps/api/node_modules/.prisma/client/index.d.ts` should be non-zero).

- [ ] **Step 3: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(db): add shift close summary count/total fields (Phase 11)"
```

---

### Task 2: `cash.types.ts` — add shared types for the new computed counts

**Files:**
- Modify: `apps/api/src/modules/cash/cash.types.ts`

**Interfaces:**
- Produces: `ShiftCloseComputedCounts` interface, consumed by Task 3 (repository return type) and Task 4 (service).

- [ ] **Step 1: Add the interface**

Append to `apps/api/src/modules/cash/cash.types.ts`:

```ts
export interface ShiftCloseComputedCounts {
  cashSalesCount: number;
  gcashSalesCount: number;
  voidedCount: number;
  refundedCount: number;
  totalTransactionCount: number;
  totalDiscountAmount: number;
  pwdScTransactionCount: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/cash/cash.types.ts
git commit -m "feat(cash): add ShiftCloseComputedCounts type"
```

---

### Task 3: `cash.repository.ts` — new count query + extend `closeShift`'s write

**Files:**
- Modify: `apps/api/src/modules/cash/cash.repository.ts`
- Test: `apps/api/src/modules/cash/cash.repository.test.ts`

**Interfaces:**
- Consumes: `ShiftCloseComputedCounts` from Task 2.
- Produces: `cashRepository.sumTransactionCountsForShift(shiftId: string): Promise<ShiftCloseComputedCounts>`, and an extended `closeShift(id, data, computed)` whose `computed` param now also accepts the 7 new fields and persists them. Consumed by Task 4 (service).

- [ ] **Step 1: Write the failing repository test**

Add to `apps/api/src/modules/cash/cash.repository.test.ts` (after the `sumTransactionsForShift` describe block, before `countAnyTransactionsForShift`'s):

```ts
describe('cashRepository.sumTransactionCountsForShift', () => {
  it('splits completed counts by payment method, sums voided/refunded/total/pwd-sc/discount', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([
      { paymentMethod: 'cash', status: 'completed', _count: { _all: 5 } },
      { paymentMethod: 'gcash', status: 'completed', _count: { _all: 3 } },
      { paymentMethod: 'cash', status: 'voided', _count: { _all: 1 } },
      { paymentMethod: 'gcash', status: 'refunded', _count: { _all: 2 } },
    ] as never);
    vi.mocked(prisma.transaction.aggregate).mockResolvedValue({ _sum: { discountAmount: new Prisma.Decimal(150) } } as never);
    vi.mocked(prisma.transaction.count).mockResolvedValueOnce(4).mockResolvedValueOnce(11);

    const result = await cashRepository.sumTransactionCountsForShift('shift-1');

    expect(result).toEqual({
      cashSalesCount: 5,
      gcashSalesCount: 3,
      voidedCount: 1,
      refundedCount: 2,
      totalTransactionCount: 11,
      totalDiscountAmount: 150,
      pwdScTransactionCount: 4,
    });
    expect(prisma.transaction.count).toHaveBeenNthCalledWith(1, {
      where: { shiftId: 'shift-1', status: 'completed', discountType: { in: ['pwd', 'senior_citizen'] } },
    });
    expect(prisma.transaction.count).toHaveBeenNthCalledWith(2, { where: { shiftId: 'shift-1' } });
  });

  it('returns all zeros when the shift has no transactions', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.transaction.aggregate).mockResolvedValue({ _sum: { discountAmount: null } } as never);
    vi.mocked(prisma.transaction.count).mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const result = await cashRepository.sumTransactionCountsForShift('shift-1');

    expect(result).toEqual({
      cashSalesCount: 0,
      gcashSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 0,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });
  });
});
```

Also extend the `prismaMock.transaction` object at the top of the file to add `aggregate: vi.fn()` alongside the existing `groupBy: vi.fn(), count: vi.fn()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api test -- cash.repository.test.ts`
Expected: FAIL — `cashRepository.sumTransactionCountsForShift is not a function`.

- [ ] **Step 3: Implement `sumTransactionCountsForShift`**

Add to `apps/api/src/modules/cash/cash.repository.ts`, directly after `sumTransactionsForShift` (after line 78):

```ts
  /**
   * Close-time-only summary counts (BIR reporting fields) — computed fresh
   * every close, unlike cashSalesTotal/gcashSalesTotal which are also live-
   * overlaid for an open shift. cashSalesCount/gcashSalesCount are COMPLETED-
   * only per payment method; voidedCount/refundedCount span both payment
   * methods; totalTransactionCount is every status; totalDiscountAmount and
   * pwdScTransactionCount are COMPLETED-only (a voided PWD sale never
   * happened for reporting purposes).
   */
  async sumTransactionCountsForShift(shiftId: string): Promise<ShiftCloseComputedCounts> {
    const [statusRows, discountAgg, pwdScCount, totalCount] = await Promise.all([
      prisma.transaction.groupBy({
        by: ['paymentMethod', 'status'],
        where: { shiftId },
        _count: { _all: true },
      }),
      prisma.transaction.aggregate({
        where: { shiftId, status: 'completed' },
        _sum: { discountAmount: true },
      }),
      prisma.transaction.count({
        where: { shiftId, status: 'completed', discountType: { in: ['pwd', 'senior_citizen'] } },
      }),
      prisma.transaction.count({ where: { shiftId } }),
    ]);

    const cashSalesCount = statusRows.find((r) => r.paymentMethod === 'cash' && r.status === 'completed')?._count._all ?? 0;
    const gcashSalesCount = statusRows.find((r) => r.paymentMethod === 'gcash' && r.status === 'completed')?._count._all ?? 0;
    const voidedCount = statusRows.filter((r) => r.status === 'voided').reduce((sum, r) => sum + r._count._all, 0);
    const refundedCount = statusRows.filter((r) => r.status === 'refunded').reduce((sum, r) => sum + r._count._all, 0);

    return {
      cashSalesCount,
      gcashSalesCount,
      voidedCount,
      refundedCount,
      totalTransactionCount: totalCount,
      totalDiscountAmount: discountAgg._sum.discountAmount?.toNumber() ?? 0,
      pwdScTransactionCount: pwdScCount,
    };
  },
```

Add the import for `ShiftCloseComputedCounts` at the top of the file:
```ts
import type { CloseShiftData, DenominationCountInput, OpenShiftData, ShiftListFilters, ShiftCloseComputedCounts } from './cash.types.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api test -- cash.repository.test.ts`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Extend `closeShift`'s `computed` param and persisted write**

In `apps/api/src/modules/cash/cash.repository.ts`, update the `closeShift` method's `computed` parameter type (around line 88-98) to add the 7 fields:

```ts
  async closeShift(
    id: string,
    data: CloseShiftData,
    computed: {
      closingCashAmount: number;
      expectedClosingCash: number;
      cashVariance: number;
      cashSalesTotal: number;
      gcashSalesTotal: number;
      transactionCount: number;
      cashSalesCount: number;
      gcashSalesCount: number;
      voidedCount: number;
      refundedCount: number;
      totalTransactionCount: number;
      totalDiscountAmount: number;
      pwdScTransactionCount: number;
      status: 'closed' | 'flagged';
      varianceApproved: boolean | null;
      closedBy: string;
    },
  ) {
```

And inside the `tx.shift.update({ data: { ... } })` call (around line 107-120), add the 7 fields after `transactionCount: computed.transactionCount,`:

```ts
          transactionCount: computed.transactionCount,
          cashSalesCount: computed.cashSalesCount,
          gcashSalesCount: computed.gcashSalesCount,
          voidedCount: computed.voidedCount,
          refundedCount: computed.refundedCount,
          totalTransactionCount: computed.totalTransactionCount,
          totalDiscountAmount: computed.totalDiscountAmount,
          pwdScTransactionCount: computed.pwdScTransactionCount,
```

- [ ] **Step 6: Update the existing `closeShift` repository test's assertions**

In `apps/api/src/modules/cash/cash.repository.test.ts`, find the `describe('cashRepository.closeShift', ...)` block and update its `computed` fixture object and the `expect(prisma.shift.update).toHaveBeenCalledWith(...)` assertion to include the 7 new keys (mirror whatever numeric fixture values the existing test already uses for `cashSalesTotal` etc., e.g. `cashSalesCount: 2, gcashSalesCount: 1, voidedCount: 0, refundedCount: 0, totalTransactionCount: 3, totalDiscountAmount: 25, pwdScTransactionCount: 1`) so the assertion still matches the full `data` object passed to `prisma.shift.update`.

- [ ] **Step 7: Run the full repository test file, confirm green**

Run: `pnpm --filter @potato-corner/api test -- cash.repository.test.ts`
Expected: PASS, 0 failures.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/cash/cash.repository.ts apps/api/src/modules/cash/cash.repository.test.ts
git commit -m "feat(cash): add sumTransactionCountsForShift, persist summary counts on close"
```

---

### Task 4: `cash.service.ts` — compute summary at close, add `getShiftSummary`

**Files:**
- Modify: `apps/api/src/modules/cash/cash.service.ts`
- Test: `apps/api/src/modules/cash/cash.service.test.ts`

**Interfaces:**
- Consumes: `cashRepository.sumTransactionCountsForShift` (Task 3), `ShiftCloseComputedCounts` (Task 2).
- Produces: `cashService.getShiftSummary(id: string): Promise<{ shift: ShiftResponseShape; summary: EodSummary }>`; `cashService.closeShift(...)` now resolves to `ShiftResponseShape & { summary: EodSummary }`. Consumed by Task 5 (router).
- `EodSummary` shape (exact keys, all snake_case):
  ```ts
  interface EodSummary {
    cash_sales_total: number;
    gcash_sales_total: number;
    total_sales: number;
    cash_sales_count: number;
    gcash_sales_count: number;
    total_transaction_count: number;
    voided_count: number;
    refunded_count: number;
    total_discount_amount: number;
    pwd_sc_transaction_count: number;
    expected_cash: number;
    actual_cash: number | null;
    variance: number | null;
    variance_status: 'AUTO_APPROVED' | 'PENDING_REVIEW' | null;
  }
  ```

- [ ] **Step 1: Extend the `ShiftRow` interface**

In `apps/api/src/modules/cash/cash.service.ts`, add the 7 new fields to the `ShiftRow` interface (after `shiftNotes: string | null;`, around line 43):

```ts
  cashSalesCount: number;
  gcashSalesCount: number;
  voidedCount: number;
  refundedCount: number;
  totalTransactionCount: number;
  totalDiscountAmount: { toNumber(): number };
  pwdScTransactionCount: number;
```

- [ ] **Step 2: Extend `toShiftResponse` to expose the 7 fields**

In `toShiftResponse` (around line 53-83), add after `transaction_count: shift.transactionCount,`:

```ts
    cash_sales_count: shift.cashSalesCount,
    gcash_sales_count: shift.gcashSalesCount,
    voided_count: shift.voidedCount,
    refunded_count: shift.refundedCount,
    total_transaction_count: shift.totalTransactionCount,
    total_discount_amount: shift.totalDiscountAmount.toNumber(),
    pwd_sc_transaction_count: shift.pwdScTransactionCount,
```

- [ ] **Step 3: Add the `buildEodSummary` helper**

Add directly after `toShiftResponse` (before `withLiveSalesTotals`):

```ts
interface EodSummary {
  cash_sales_total: number;
  gcash_sales_total: number;
  total_sales: number;
  cash_sales_count: number;
  gcash_sales_count: number;
  total_transaction_count: number;
  voided_count: number;
  refunded_count: number;
  total_discount_amount: number;
  pwd_sc_transaction_count: number;
  expected_cash: number;
  actual_cash: number | null;
  variance: number | null;
  variance_status: 'AUTO_APPROVED' | 'PENDING_REVIEW' | null;
}

/**
 * Builds the EOD summary object shared by POST /:shiftId/close and
 * GET /:shiftId/summary. For an OPEN (active) shift, actual_cash/variance/
 * variance_status are null — no closing count has happened yet, only
 * expected_cash can be computed live. variance_status is derived purely
 * from `status` ('flagged' -> PENDING_REVIEW, else -> AUTO_APPROVED) — see
 * the plan's "resolved ambiguities" note on why a manually-approved/
 * rejected flagged shift also reads as AUTO_APPROVED once resolved.
 */
function buildEodSummary(
  shift: ShiftRow,
  counts: ShiftCloseComputedCounts,
  sales: { cashSalesTotal: number; gcashSalesTotal: number },
): EodSummary {
  const isOpen = shift.status === 'active';
  return {
    cash_sales_total: sales.cashSalesTotal,
    gcash_sales_total: sales.gcashSalesTotal,
    total_sales: sales.cashSalesTotal + sales.gcashSalesTotal,
    cash_sales_count: counts.cashSalesCount,
    gcash_sales_count: counts.gcashSalesCount,
    total_transaction_count: counts.totalTransactionCount,
    voided_count: counts.voidedCount,
    refunded_count: counts.refundedCount,
    total_discount_amount: counts.totalDiscountAmount,
    pwd_sc_transaction_count: counts.pwdScTransactionCount,
    expected_cash: isOpen ? shift.openingCashAmount.toNumber() + sales.cashSalesTotal : (shift.expectedClosingCash?.toNumber() ?? 0),
    actual_cash: isOpen ? null : (shift.closingCashAmount?.toNumber() ?? null),
    variance: isOpen ? null : (shift.cashVariance?.toNumber() ?? null),
    variance_status: isOpen ? null : shift.status === 'flagged' ? 'PENDING_REVIEW' : 'AUTO_APPROVED',
  };
}
```

Add the import at the top of the file:
```ts
import { CashError, type ApproveVarianceData, type CloseShiftData, type OpenShiftData, type ShiftListFilters, type ShiftCloseComputedCounts } from './cash.types.js';
```

- [ ] **Step 4: Write the failing service tests for `closeShift`'s new fields**

Add to `apps/api/src/modules/cash/cash.service.test.ts`, inside `describe('cashService.closeShift', ...)`, after the existing "computes expected_closing_cash..." test:

```ts
  it('computes and persists all 7 summary count/total fields, and returns them on the shift response plus in `summary`', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(500),
      gcashSalesTotal: new Prisma.Decimal(300),
      transactionCount: 4,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 3,
      gcashSalesCount: 2,
      voidedCount: 1,
      refundedCount: 1,
      totalTransactionCount: 7,
      totalDiscountAmount: 40,
      pwdScTransactionCount: 2,
    });
    vi.mocked(cashRepository.closeShift).mockImplementation((_id, _data, computed) =>
      Promise.resolve({
        ...asShiftRow(computed),
        cashSalesCount: computed.cashSalesCount,
        gcashSalesCount: computed.gcashSalesCount,
        voidedCount: computed.voidedCount,
        refundedCount: computed.refundedCount,
        totalTransactionCount: computed.totalTransactionCount,
        totalDiscountAmount: decimal(computed.totalDiscountAmount as number),
        pwdScTransactionCount: computed.pwdScTransactionCount,
      } as never),
    );

    const result = await cashService.closeShift(
      'shift-1',
      { denominations: [{ denomination: 1000, quantity: 1 }, { denomination: 500, quantity: 1 }] },
      SUPERVISOR,
      null,
    );

    expect(cashRepository.closeShift).toHaveBeenCalledWith(
      'shift-1',
      expect.anything(),
      expect.objectContaining({
        cashSalesCount: 3,
        gcashSalesCount: 2,
        voidedCount: 1,
        refundedCount: 1,
        totalTransactionCount: 7,
        totalDiscountAmount: 40,
        pwdScTransactionCount: 2,
      }),
    );
    expect(result.cash_sales_count).toBe(3);
    expect(result.gcash_sales_count).toBe(2);
    expect(result.total_transaction_count).toBe(7);
    expect(result.summary).toMatchObject({
      cash_sales_total: 500,
      gcash_sales_total: 300,
      total_sales: 800,
      cash_sales_count: 3,
      gcash_sales_count: 2,
      total_transaction_count: 7,
      voided_count: 1,
      refunded_count: 1,
      total_discount_amount: 40,
      pwd_sc_transaction_count: 2,
      expected_cash: 1500,
      actual_cash: 1500,
      variance_status: 'AUTO_APPROVED',
    });
  });
```

Also add `sumTransactionCountsForShift: vi.fn()` to the `vi.mock('./cash.repository.js', ...)` block at the top of the file, alongside the existing mocked methods.

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api test -- cash.service.test.ts`
Expected: FAIL — `cashRepository.sumTransactionCountsForShift` mock returns `undefined`, or `result.summary` is `undefined` (since `closeShift` doesn't compute/attach it yet).

- [ ] **Step 6: Update `closeShift` in the service**

In `apps/api/src/modules/cash/cash.service.ts`, replace the body of `closeShift` (lines 163-219) with:

```ts
  async closeShift(id: string, data: CloseShiftData, actor: ActorContext, ipAddress: string | null) {
    const shift = (await cashRepository.findShiftById(id)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'Shift not found', 404);
    if (shift.status !== 'active') {
      throw new CashError('SHIFT_NOT_OPEN', 'Only an open shift can be closed', 409);
    }
    if (actor.role !== ROLES.SUPER_ADMIN && shift.openedBy !== actor.id) {
      throw new CashError('SHIFT_UNAUTHORIZED_CLOSE', 'Only the supervisor who opened this shift, or a super_admin, may close it', 403);
    }

    const closingCashAmount = data.denominations.reduce((sum, d) => sum + d.denomination * d.quantity, 0);
    const [sales, counts] = await Promise.all([
      cashRepository.sumTransactionsForShift(id),
      cashRepository.sumTransactionCountsForShift(id),
    ]);
    const cashSalesTotal = sales.cashSalesTotal;
    const gcashSalesTotal = sales.gcashSalesTotal;
    const expectedClosingCash = new Prisma.Decimal(shift.openingCashAmount.toNumber()).plus(cashSalesTotal);
    const cashVariance = new Prisma.Decimal(closingCashAmount).minus(expectedClosingCash);
    const varianceCents = toCents(cashVariance.toNumber());
    const withinTolerance = Math.abs(varianceCents) <= toCents(DEFAULT_VARIANCE_TOLERANCE);

    if (!withinTolerance && !data.varianceExplanation) {
      throw new CashError(
        'VARIANCE_EXPLANATION_REQUIRED',
        'A written explanation (minimum 50 characters) is required when the cash variance is outside tolerance',
        400,
      );
    }

    const status: 'closed' | 'flagged' = withinTolerance ? 'closed' : 'flagged';
    const varianceApproved = withinTolerance ? true : null;

    const updated = (await cashRepository.closeShift(id, data, {
      closingCashAmount,
      expectedClosingCash: expectedClosingCash.toNumber(),
      cashVariance: cashVariance.toNumber(),
      cashSalesTotal: cashSalesTotal.toNumber(),
      gcashSalesTotal: gcashSalesTotal.toNumber(),
      transactionCount: sales.transactionCount,
      cashSalesCount: counts.cashSalesCount,
      gcashSalesCount: counts.gcashSalesCount,
      voidedCount: counts.voidedCount,
      refundedCount: counts.refundedCount,
      totalTransactionCount: counts.totalTransactionCount,
      totalDiscountAmount: counts.totalDiscountAmount,
      pwdScTransactionCount: counts.pwdScTransactionCount,
      status,
      varianceApproved,
      closedBy: actor.id,
    })) as ShiftRow;
    const response = toShiftResponse(updated);
    const summary = buildEodSummary(updated, counts, { cashSalesTotal: cashSalesTotal.toNumber(), gcashSalesTotal: gcashSalesTotal.toNumber() });

    await recordAuditLog({
      action: status === 'closed' ? 'SHIFT_CLOSED' : 'SHIFT_FLAGGED_FOR_REVIEW',
      entityType: 'shift',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: shift.branchId,
      beforeState: toShiftResponse(shift),
      afterState: response,
      ipAddress,
    });

    return { ...response, summary };
  },
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api test -- cash.service.test.ts`
Expected: PASS.

- [ ] **Step 8: Write failing tests for `getShiftSummary`**

Add a new `describe` block at the end of `apps/api/src/modules/cash/cash.service.test.ts`:

```ts
describe('cashService.getShiftSummary', () => {
  it('rejects with 404 SHIFT_NOT_FOUND when the shift does not exist', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(null);

    await expect(cashService.getShiftSummary('missing')).rejects.toMatchObject({ code: 'SHIFT_NOT_FOUND', statusCode: 404 });
  });

  it('computes summary live for an OPEN shift, with actual_cash/variance/variance_status null', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'active', openingCashAmount: decimal(1000) }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(200),
      gcashSalesTotal: new Prisma.Decimal(50),
      transactionCount: 3,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 2,
      gcashSalesCount: 1,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 3,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 0,
    });

    const result = await cashService.getShiftSummary('shift-1');

    expect(result.shift.status).toBe('active');
    expect(result.summary).toMatchObject({
      cash_sales_total: 200,
      gcash_sales_total: 50,
      total_sales: 250,
      expected_cash: 1200,
      actual_cash: null,
      variance: null,
      variance_status: null,
    });
  });

  it('returns the stored (not recomputed) values for a CLOSED shift', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(
      shiftRow({
        status: 'closed',
        cashSalesTotal: decimal(500),
        gcashSalesTotal: decimal(100),
        cashSalesCount: 4,
        gcashSalesCount: 1,
        voidedCount: 0,
        refundedCount: 1,
        totalTransactionCount: 6,
        totalDiscountAmount: decimal(75),
        pwdScTransactionCount: 3,
        closingCashAmount: decimal(1500),
        expectedClosingCash: decimal(1500),
        cashVariance: decimal(0),
      }) as never,
    );

    const result = await cashService.getShiftSummary('shift-1');

    expect(cashRepository.sumTransactionsForShift).not.toHaveBeenCalled();
    expect(cashRepository.sumTransactionCountsForShift).not.toHaveBeenCalled();
    expect(result.summary).toMatchObject({
      cash_sales_total: 500,
      gcash_sales_total: 100,
      total_sales: 600,
      pwd_sc_transaction_count: 3,
      actual_cash: 1500,
      variance: 0,
      variance_status: 'AUTO_APPROVED',
    });
  });

  it('counts only COMPLETED PWD/Senior-Citizen transactions in pwd_sc_transaction_count (live path)', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'active' }) as never);
    vi.mocked(cashRepository.sumTransactionsForShift).mockResolvedValue({
      cashSalesTotal: new Prisma.Decimal(0),
      gcashSalesTotal: new Prisma.Decimal(0),
      transactionCount: 0,
    });
    vi.mocked(cashRepository.sumTransactionCountsForShift).mockResolvedValue({
      cashSalesCount: 0,
      gcashSalesCount: 0,
      voidedCount: 0,
      refundedCount: 0,
      totalTransactionCount: 0,
      totalDiscountAmount: 0,
      pwdScTransactionCount: 5,
    });

    const result = await cashService.getShiftSummary('shift-1');

    expect(result.summary.pwd_sc_transaction_count).toBe(5);
    expect(cashRepository.sumTransactionCountsForShift).toHaveBeenCalledWith('shift-1');
  });

  it('flags a FLAGGED shift as PENDING_REVIEW in variance_status', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue(shiftRow({ status: 'flagged', cashVariance: decimal(-50) }) as never);

    const result = await cashService.getShiftSummary('shift-1');

    expect(result.summary.variance_status).toBe('PENDING_REVIEW');
  });
});
```

Update the `shiftRow` test helper (top of file) to include defaults for the 7 new fields, so overrides work cleanly:
```ts
    cashSalesCount: 0,
    gcashSalesCount: 0,
    voidedCount: 0,
    refundedCount: 0,
    totalTransactionCount: 0,
    totalDiscountAmount: decimal(0),
    pwdScTransactionCount: 0,
```
(insert these lines into the object returned by `shiftRow(overrides)`, alongside the existing `transactionCount: 0,` line).

- [ ] **Step 9: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api test -- cash.service.test.ts`
Expected: FAIL — `cashService.getShiftSummary is not a function`.

- [ ] **Step 10: Implement `getShiftSummary`**

Add to the `cashService` object in `apps/api/src/modules/cash/cash.service.ts`, after `getShiftById` (after line 151):

```ts
  async getShiftSummary(id: string) {
    const shift = (await cashRepository.findShiftById(id)) as ShiftRow | null;
    if (!shift) throw new CashError('SHIFT_NOT_FOUND', 'Shift not found', 404);

    if (shift.status === 'active') {
      const [sales, counts] = await Promise.all([
        cashRepository.sumTransactionsForShift(id),
        cashRepository.sumTransactionCountsForShift(id),
      ]);
      return {
        shift: toShiftResponse(shift),
        summary: buildEodSummary(shift, counts, {
          cashSalesTotal: sales.cashSalesTotal.toNumber(),
          gcashSalesTotal: sales.gcashSalesTotal.toNumber(),
        }),
      };
    }

    const counts: ShiftCloseComputedCounts = {
      cashSalesCount: shift.cashSalesCount,
      gcashSalesCount: shift.gcashSalesCount,
      voidedCount: shift.voidedCount,
      refundedCount: shift.refundedCount,
      totalTransactionCount: shift.totalTransactionCount,
      totalDiscountAmount: shift.totalDiscountAmount.toNumber(),
      pwdScTransactionCount: shift.pwdScTransactionCount,
    };
    return {
      shift: toShiftResponse(shift),
      summary: buildEodSummary(shift, counts, {
        cashSalesTotal: shift.cashSalesTotal.toNumber(),
        gcashSalesTotal: shift.gcashSalesTotal.toNumber(),
      }),
    };
  },
```

- [ ] **Step 11: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api test -- cash.service.test.ts`
Expected: PASS, all tests (existing + new) green.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/modules/cash/cash.service.ts apps/api/src/modules/cash/cash.service.test.ts
git commit -m "feat(cash): compute EOD summary on close, add getShiftSummary"
```

---

### Task 5: `cash.router.ts` — add `GET /:shiftId/summary`

**Files:**
- Modify: `apps/api/src/modules/cash/cash.router.ts`
- Test: `apps/api/src/modules/cash/cash.router.test.ts`

**Interfaces:**
- Consumes: `cashService.getShiftSummary` (Task 4).
- Produces: `GET /api/cash/:shiftId/summary` → `{ data: { shift, summary }, error: null, meta: null }`.

- [ ] **Step 1: Write the failing router tests**

Add to `apps/api/src/modules/cash/cash.router.test.ts`:

1. Add `'/:shiftId/summary'` to the `protectedRoutes` array (401-with-no-auth-header test) at the top:
```ts
    { method: 'get', path: '/:shiftId/summary' },
```

2. Add `getShiftSummary: vi.fn()` to the `vi.mock('./cash.service.js', ...)` block's mocked methods.

3. Add a new `describe` block at the end of the file:

```ts
describe('GET /:shiftId/summary', () => {
  it('staff cannot fetch a shift summary — 403', async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/:shiftId/summary');
    const token = generateStaffToken(BRANCH_1);
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 } });
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(cashService.getShiftSummary).not.toHaveBeenCalled();
  });

  it("blocks a supervisor from fetching another branch's shift summary — 403 BRANCH_ACCESS_DENIED", async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/:shiftId/summary');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 } });
    const res = mockRes();
    vi.mocked(cashService.getShiftSummary).mockResolvedValue({ shift: { id: SHIFT_1, branch_id: BRANCH_2 }, summary: {} } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: { code: 'BRANCH_ACCESS_DENIED' } }));
  });

  it('allows a supervisor to fetch their own branch shift summary — 200', async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/:shiftId/summary');
    const token = generateSupervisorToken([BRANCH_1]);
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 } });
    const res = mockRes();
    vi.mocked(cashService.getShiftSummary).mockResolvedValue({ shift: { id: SHIFT_1, branch_id: BRANCH_1 }, summary: {} } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('allows a super_admin to fetch any branch shift summary — 200', async () => {
    const handlers = getRouteHandlers(cashRouter, 'get', '/:shiftId/summary');
    const token = generateSuperAdminToken();
    const req = mockReq({ ...authHeader(token), params: { shiftId: SHIFT_1 } });
    const res = mockRes();
    vi.mocked(cashService.getShiftSummary).mockResolvedValue({ shift: { id: SHIFT_1, branch_id: BRANCH_2 }, summary: {} } as never);

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @potato-corner/api test -- cash.router.test.ts`
Expected: FAIL — `No route registered for GET /:shiftId/summary`.

- [ ] **Step 3: Implement the route**

Add to `apps/api/src/modules/cash/cash.router.ts`, directly after the `GET /:shiftId` route (after line 120, before `POST /:shiftId/close`):

```ts
router.get('/:shiftId/summary', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = await cashService.getShiftSummary(req.params.shiftId as string);
    // Same inline branch-check pattern as GET /:shiftId — the branch is only
    // known once the shift has been fetched.
    if (req.user.role !== ROLES.SUPER_ADMIN && !req.user.branch_ids.includes(result.shift.branch_id)) {
      res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
      return;
    }
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @potato-corner/api test -- cash.router.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/cash/cash.router.ts apps/api/src/modules/cash/cash.router.test.ts
git commit -m "feat(cash): add GET /:shiftId/summary endpoint"
```

---

### Task 6: `packages/shared` — extend Zod schemas and types

**Files:**
- Modify: `packages/shared/src/schemas/shift.schema.ts`
- Modify: `packages/shared/src/types/index.ts`

**Interfaces:**
- Produces: `shiftResponseSchema` gains 7 fields; new `shiftSummarySchema`, `shiftSummaryResponseSchema` (the `{shift, summary}` wrapper); new types `ShiftSummary`, `ShiftSummaryResponse`. Consumed by Task 11 (frontend hooks) and by the backend implicitly (already using plain objects, no schema import needed there for responses).

- [ ] **Step 1: Extend `shiftResponseSchema`**

In `packages/shared/src/schemas/shift.schema.ts`, add to `shiftResponseSchema` (after `transaction_count: z.number().int(),`, line 72):

```ts
  cash_sales_count: z.number().int(),
  gcash_sales_count: z.number().int(),
  voided_count: z.number().int(),
  refunded_count: z.number().int(),
  total_transaction_count: z.number().int(),
  total_discount_amount: z.number(),
  pwd_sc_transaction_count: z.number().int(),
```

- [ ] **Step 2: Add `shiftSummarySchema` and `shiftSummaryResponseSchema`**

Add at the end of `packages/shared/src/schemas/shift.schema.ts`:

```ts
export const shiftSummarySchema = z.object({
  cash_sales_total: z.number(),
  gcash_sales_total: z.number(),
  total_sales: z.number(),
  cash_sales_count: z.number().int(),
  gcash_sales_count: z.number().int(),
  total_transaction_count: z.number().int(),
  voided_count: z.number().int(),
  refunded_count: z.number().int(),
  total_discount_amount: z.number(),
  pwd_sc_transaction_count: z.number().int(),
  expected_cash: z.number(),
  actual_cash: z.number().nullable(),
  variance: z.number().nullable(),
  variance_status: z.enum(['AUTO_APPROVED', 'PENDING_REVIEW']).nullable(),
});

/** Response shape of GET /api/cash/:shiftId/summary. Note POST /:shiftId/close returns a flat ShiftResponse with an extra `summary` key instead of this wrapper — see the Phase 11 plan's "resolved ambiguities" note for why. */
export const shiftSummaryResponseSchema = z.object({
  shift: shiftResponseSchema,
  summary: shiftSummarySchema,
});

/** ShiftResponse extended with the `summary` key returned only by POST /:shiftId/close. */
export const shiftCloseResponseSchema = shiftResponseSchema.extend({
  summary: shiftSummarySchema,
});
```

- [ ] **Step 3: Add the type exports**

In `packages/shared/src/types/index.ts`, after `export type ShiftListResponse = z.infer<typeof schemas.shiftListResponseSchema>;` (line 124):

```ts
export type ShiftSummary = z.infer<typeof schemas.shiftSummarySchema>;
export type ShiftSummaryResponse = z.infer<typeof schemas.shiftSummaryResponseSchema>;
export type ShiftCloseResponse = z.infer<typeof schemas.shiftCloseResponseSchema>;
```

- [ ] **Step 4: Type-check the shared package**

Run: `pnpm --filter @potato-corner/shared type-check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas/shift.schema.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): add shift summary count fields and EOD summary schemas"
```

---

### Task 7: Integration test skeleton additions

**Files:**
- Modify: `apps/api/src/modules/cash/cash.integration.test.ts`

**Interfaces:**
- Consumes: nothing new — extends the existing (currently all-stub) integration test file.

- [ ] **Step 1: Add 3 new TODO-documented stub cases**

Add to `apps/api/src/modules/cash/cash.integration.test.ts`, inside the existing `describe.skipIf(!canRunIntegrationTests)` block, following the file's existing stub pattern (`expect(true).toBe(true)` + a `// TODO:` comment enumerating the real assertions):

```ts
  it.todo('GET /api/cash/:shiftId/summary returns a live-computed summary for an OPEN shift');
  // TODO: open a shift, create 2 completed cash + 1 completed gcash + 1 voided transaction against
  // it, call GET /:shiftId/summary, assert summary.cash_sales_count === 2, summary.voided_count === 1,
  // summary.actual_cash === null, summary.variance_status === null.

  it.todo('GET /api/cash/:shiftId/summary returns stored values for a CLOSED shift, matching the close response');
  // TODO: open + close a shift with a matching denomination count, call GET /:shiftId/summary,
  // assert its `summary` object deep-equals the `summary` key returned by the earlier POST
  // /:shiftId/close call (same numbers, both computed once and persisted).

  it.todo('POST /api/cash/:shiftId/close response includes all 7 new summary fields on the shift and a full `summary` object');
  // TODO: open a shift, record a mix of completed/voided/PWD-discounted transactions, close it,
  // assert response.data.cash_sales_count/voided_count/pwd_sc_transaction_count/etc. are present
  // and response.data.summary.total_sales === cash_sales_total + gcash_sales_total.
```

Use `it.todo(...)` (Vitest's built-in "documented, not yet implemented" marker) rather than `expect(true).toBe(true)`, matching how the rest of this file should ideally read — if the existing stubs in the file already use `expect(true).toBe(true)` instead of `it.todo`, follow the file's existing convention instead for consistency (check the top of the file first).

- [ ] **Step 2: Confirm the file still runs (skipped, not failing)**

Run: `pnpm --filter @potato-corner/api test -- cash.integration.test.ts`
Expected: PASS — all cases skipped (no `TEST_DATABASE_URL` in the dev environment) or passing as stubs, 0 failures.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/cash/cash.integration.test.ts
git commit -m "test(cash): document intended integration coverage for shift summary endpoint"
```

---

### Task 8: Frontend — `useShiftSummary` hook

**Files:**
- Modify: `apps/web/hooks/queries/use-shifts.ts`

**Interfaces:**
- Consumes: `GET /api/cash/:shiftId/summary` (Task 5), `ShiftSummaryResponse`/`ShiftCloseResponse` types (Task 6).
- Produces: `useShiftSummary(shiftId): UseQueryResult<ShiftSummaryResponse>`. Consumed by Task 9 (close page), Task 11 (admin/shifts detail), Task 12 (supervisor/cash).
- **Correction from the original investigation pass:** `apps/web/hooks/queries/use-transactions.ts` **already exists** (it was missed during planning — a repo-wide search returned no match at the time, but the file is present with 143 lines of working code, uncommitted alongside the rest of Phase 10). It already exports `useTransactions(filters: Partial<TransactionListQuery>)`, whose `buildQueryString` already handles `shift_id`, `branch_id`, `page`, `limit`, and is `enabled: Boolean(filters.branch_id)` — exactly what the shift-detail transaction list needs. **Do not create a new file or a new `useShiftTransactions` hook.** Tasks 11 and 12 call the existing `useTransactions({ shift_id, branch_id, page, limit })` directly. This file also exports `useTransaction`, `useCreateTransaction`, `useVoidTransaction`, `useRefundTransaction`, `useMarkReceiptPrinted` — all in active use elsewhere (e.g. the POS terminal page) — so it must not be overwritten, only left untouched by this task.

- [ ] **Step 1: Add `useShiftSummary` to `use-shifts.ts`**

Add to `apps/web/hooks/queries/use-shifts.ts`, after `useShift` (after line 52):

```ts
export function useShiftSummary(shiftId: string | null | undefined) {
  return useQuery({
    queryKey: ['shift-summary', shiftId],
    queryFn: async () => {
      const response = await apiClient<ShiftSummaryResponse>(`/api/cash/${shiftId}/summary`);
      if (!response.data) throw new Error(errorMessage(response, 'Failed to load shift summary'));
      return response.data;
    },
    enabled: Boolean(shiftId),
    // Matches useCurrentShift's cadence — meaningful for an OPEN shift's
    // live preview; a closed/flagged shift's summary never changes, but a
    // short staleTime is harmless there too.
    staleTime: 10 * 1000,
  });
}
```

Add `ShiftSummaryResponse` to the type-only import at the top of the file:
```ts
import type {
  ApproveVarianceInput,
  CloseShiftInput,
  OpenShiftInput,
  ShiftListResponse,
  ShiftResponse,
  ShiftSummaryResponse,
} from '@potato-corner/shared';
```

- [ ] **Step 2: Update `useCloseShift`'s return type usage to include `summary`**

`useCloseShift`'s `mutationFn` currently types the response as `ShiftResponse`. Change it to `ShiftCloseResponse` (the flat-shift-plus-`summary` shape from Task 6) so callers can read `shift.summary` after closing:

```ts
export function useCloseShift(branchId: string | null | undefined, shiftId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CloseShiftInput) => {
      const response = await apiClient<ShiftCloseResponse>(`/api/cash/${shiftId}/close`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!response.data) throw new Error(errorMessage(response, 'Failed to close shift'));
      return response.data;
    },
    onSuccess: (shift) => {
      useShiftStore.getState().clearShift();
      invalidateShifts(queryClient, branchId);
      queryClient.setQueryData(['shift', shiftId], shift);
      void queryClient.invalidateQueries({ queryKey: ['shift-summary', shiftId] });
      toast.success(shift.status === 'flagged' ? 'Shift closed — pending variance review' : 'Shift closed');
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
```

Add `ShiftCloseResponse` to the same type-only import.

- [ ] **Step 3: Type-check the web app**

Run: `pnpm --filter @potato-corner/web type-check`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/hooks/queries/use-shifts.ts
git commit -m "feat(web): add useShiftSummary hook, extend useCloseShift's response type"
```

---

### Task 9: Frontend — enhance `/shift/close` with the live EOD preview and review-warning panel

**Files:**
- Modify: `apps/web/app/(pos)/shift/close/page.tsx`

**Interfaces:**
- Consumes: `useShiftSummary` (Task 8), `formatCurrency` from `@/lib/utils`.

- [ ] **Step 1: Add the live summary preview above the denomination form**

In `apps/web/app/(pos)/shift/close/page.tsx`, import `useShiftSummary` and `formatCurrency`:

```ts
import { formatCurrency } from '@/lib/utils';
import { useCurrentShift, useCloseShift, useShiftSummary } from '@/hooks/queries/use-shifts';
```

Add the summary query after the existing `useCurrentShift` call:
```ts
  const { data: summaryData } = useShiftSummary(shift?.id);
  const summary = summaryData?.summary;
```

Insert a new `Card` directly above the existing "Expected/Actual/Variance" `Card` (before line 65's `<Card>`):

```tsx
      {summary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Shift Summary (so far)</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Total Sales</p>
              <p className="font-semibold tabular-nums">{formatCurrency(summary.total_sales)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Cash Sales</p>
              <p className="font-semibold tabular-nums">{formatCurrency(summary.cash_sales_total)} ({summary.cash_sales_count})</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">GCash Sales</p>
              <p className="font-semibold tabular-nums">{formatCurrency(summary.gcash_sales_total)} ({summary.gcash_sales_count})</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Transactions</p>
              <p className="font-semibold tabular-nums">{summary.total_transaction_count}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Voided</p>
              <p className="font-semibold tabular-nums">{summary.voided_count}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Refunded</p>
              <p className="font-semibold tabular-nums">{summary.refunded_count}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Discounts</p>
              <p className="font-semibold tabular-nums">{formatCurrency(summary.total_discount_amount)}</p>
            </div>
          </CardContent>
        </Card>
      )}
```

- [ ] **Step 2: Clarify the existing variance-review warning copy**

The existing warning card (lines 88-108) already says "This shift will require supervisor approval before closing" — this is inaccurate (`POST /:shiftId/approve-variance` is `adminOnly`, i.e. super_admin only, confirmed in `cash.router.test.ts`). Update the `CardTitle` text and add one explanatory line:

```tsx
          <CardHeader>
            <CardTitle className="text-sm text-orange-600">
              This shift will be flagged for review — a super admin must approve or reject the variance before it counts as fully closed
            </CardTitle>
          </CardHeader>
```

- [ ] **Step 3: Manually verify in the browser**

Run the dev server (`pnpm dev` from repo root, or whatever this repo's `run` skill/pattern is), open an active shift's `/shift/close` page, and confirm: the new summary card renders with real numbers, the denomination form and variance card below it are unchanged in behavior, and closing still works end to end.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/(pos)/shift/close/page.tsx"
git commit -m "feat(web): show live EOD summary preview and clarify review copy on shift close"
```

---

### Task 10: Frontend — shared shift-review components

**Files:**
- Create: `apps/web/components/admin/shifts/shift-denomination-table.tsx`
- Create: `apps/web/components/admin/shifts/review-variance-dialog.tsx`
- Create: `apps/web/components/admin/shifts/shift-status-badge.tsx`

**Interfaces:**
- Consumes: `useApproveVariance` (existing, Phase 9), `ShiftDenominationResponse`/`ShiftResponse` types, `formatCurrency`.
- Produces: `<ShiftDenominationTable denominations phase />`, `<ReviewVarianceDialog open onOpenChange shift />`, `<ShiftStatusBadge status />`. Consumed by Task 11 (admin/shifts detail) and Task 12 (supervisor/cash).

- [ ] **Step 1: `shift-status-badge.tsx`**

Create `apps/web/components/admin/shifts/shift-status-badge.tsx`:

```tsx
import { Badge } from '@/components/ui/badge';

/**
 * Local status->color map, not the shared STATUS_MAPS.shift entry in
 * status-badge.tsx (which uses green/gray/red for active/closed/flagged) —
 * this phase's brief explicitly specifies OPEN=blue, CLOSED=green,
 * PENDING_REVIEW=amber for the shift review UI specifically, so it's defined
 * locally here rather than changing the shared map's colors for every other
 * consumer (same pattern as the price-overrides approval page's own local
 * STATUS_BADGE_VARIANT).
 */
const VARIANT: Record<string, 'pending' | 'active' | 'warning'> = {
  active: 'pending', // blue
  closed: 'active', // green
  flagged: 'warning', // amber
};

const LABEL: Record<string, string> = {
  active: 'Open',
  closed: 'Closed',
  flagged: 'Pending Review',
};

export function ShiftStatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANT[status] ?? 'default'}>{LABEL[status] ?? status}</Badge>;
}
```

- [ ] **Step 2: `shift-denomination-table.tsx`**

Create `apps/web/components/admin/shifts/shift-denomination-table.tsx`:

```tsx
import type { ShiftResponse } from '@potato-corner/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrency } from '@/lib/utils';

interface ShiftDenominationTableProps {
  denominations: NonNullable<ShiftResponse['denominations']>;
  phase: 'opening' | 'closing';
}

/** Read-only denomination breakdown for the admin shift detail view — unlike apps/web/components/pos/denomination-table.tsx, this never accepts input. */
export function ShiftDenominationTable({ denominations, phase }: ShiftDenominationTableProps) {
  const rows = denominations.filter((d) => d.phase === phase);
  const total = rows.reduce((sum, r) => sum + r.subtotal, 0);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No {phase} count recorded.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Denomination</TableHead>
          <TableHead>Quantity</TableHead>
          <TableHead className="text-right">Subtotal</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">{formatCurrency(row.denomination)}</TableCell>
            <TableCell>{row.quantity}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(row.subtotal)}</TableCell>
          </TableRow>
        ))}
        <TableRow>
          <TableCell colSpan={2} className="font-semibold">
            Total
          </TableCell>
          <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(total)}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 3: `review-variance-dialog.tsx`**

Create `apps/web/components/admin/shifts/review-variance-dialog.tsx` (mirrors `apps/web/components/admin/approvals/review-price-override-dialog.tsx`'s pattern, but for `useApproveVariance`, which already exists from Phase 9 and requires `notes` ≥ 50 chars for both approve and reject per `approveVarianceSchema`):

```tsx
'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ShiftResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import { useApproveVariance } from '@/hooks/queries/use-shifts';

const MIN_NOTES_LENGTH = 50;

interface ReviewVarianceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shift: ShiftResponse;
}

/** Notes are required (>= 50 chars) for both approve and reject here — unlike price-override review, approveVarianceSchema has no "optional for approval" carve-out. */
export function ReviewVarianceDialog({ open, onOpenChange, shift }: ReviewVarianceDialogProps) {
  const approveVariance = useApproveVariance(shift.id);
  const [notes, setNotes] = useState('');
  const notesTooShort = notes.trim().length < MIN_NOTES_LENGTH;

  function handleOpenChange(next: boolean) {
    if (!next) setNotes('');
    onOpenChange(next);
  }

  async function handleDecision(approved: boolean) {
    if (notesTooShort) return;
    await approveVariance.mutateAsync({ approved, notes: notes.trim() });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Review Cash Variance</DialogTitle>
          <DialogDescription>Shift {shift.id.slice(0, 8)} — variance {formatCurrency(shift.cash_variance ?? 0)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Cashier's explanation</p>
            <p>{shift.variance_explanation ?? '—'}</p>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              Your written justification <span className="italic">(required, min {MIN_NOTES_LENGTH} characters)</span>
            </p>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Explain your approve/reject decision" />
            <p className="mt-1 text-xs text-muted-foreground">{notes.trim().length}/{MIN_NOTES_LENGTH}</p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="destructive" disabled={approveVariance.isPending || notesTooShort} onClick={() => void handleDecision(false)}>
            {approveVariance.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reject
          </Button>
          <Button type="button" disabled={approveVariance.isPending || notesTooShort} onClick={() => void handleDecision(true)}>
            {approveVariance.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @potato-corner/web type-check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/admin/shifts
git commit -m "feat(web): add shared shift-review components (status badge, denomination table, variance dialog)"
```

---

### Task 11: Frontend — `/admin/shifts` list page + `/admin/shifts/[shiftId]` detail page

**Files:**
- Create: `apps/web/app/(admin)/admin/shifts/page.tsx`
- Create: `apps/web/app/(admin)/admin/shifts/[shiftId]/page.tsx`
- Modify: `apps/web/components/admin/admin-sidebar.tsx`

**Interfaces:**
- Consumes: `useShifts`, `useShift`, `useShiftSummary` (Task 8), `ShiftStatusBadge`/`ShiftDenominationTable`/`ReviewVarianceDialog` (Task 10), the pre-existing `useTransactions` from `apps/web/hooks/queries/use-transactions.ts` (do not create a new hook — see Task 8's correction note), `useAuth` for role check.

- [ ] **Step 1: `/admin/shifts` list page**

Create `apps/web/app/(admin)/admin/shifts/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { ShiftResponse } from '@potato-corner/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ShiftStatusBadge } from '@/components/admin/shifts/shift-status-badge';
import { formatCurrency } from '@/lib/utils';
import { useShifts } from '@/hooks/queries/use-shifts';

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'flagged', label: 'Pending Review' },
] as const;

/** super_admin sees every branch — GET /api/cash skips branchGuard entirely for this role, so no branch_id filter is sent. */
export default function AdminShiftsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<string>('all');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const { data, isLoading, isError, refetch } = useShifts({
    status: status === 'all' ? undefined : (status as 'active' | 'closed' | 'flagged'),
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<ShiftResponse>[] = [
    { id: 'branch', header: 'Branch', accessorKey: 'branch_id' },
    { id: 'opened_by', header: 'Opened By', accessorKey: 'opened_by' },
    {
      id: 'started_at',
      header: 'Opened At',
      cell: ({ row }) => new Date(row.original.started_at).toLocaleString(),
    },
    {
      id: 'closed_at',
      header: 'Closed At',
      cell: ({ row }) => (row.original.closed_at ? new Date(row.original.closed_at).toLocaleString() : '—'),
    },
    { id: 'status', header: 'Status', cell: ({ row }) => <ShiftStatusBadge status={row.original.status} /> },
    {
      id: 'total_sales',
      header: 'Total Sales',
      cell: ({ row }) => formatCurrency(row.original.cash_sales_total + row.original.gcash_sales_total),
    },
    {
      id: 'variance',
      header: 'Variance',
      cell: ({ row }) => {
        const variance = row.original.cash_variance;
        if (variance === null) return '—';
        return <span className={variance === 0 ? '' : 'text-destructive'}>{formatCurrency(variance)}</span>;
      },
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Shifts</h1>
        <p className="text-sm text-muted-foreground">Every shift across every branch. Click a row for the full cash reconciliation detail.</p>
      </div>

      <Select
        value={status}
        onValueChange={(value) => {
          setStatus(value);
          setPagination((prev) => ({ ...prev, pageIndex: 0 }));
        }}
      >
        <SelectTrigger className="w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_FILTERS.map((filter) => (
            <SelectItem key={filter.value} value={filter.value}>
              {filter.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <DataTable
        columns={columns}
        data={data?.shifts ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(shift) => router.push(`/admin/shifts/${shift.id}`)}
        emptyState={<EmptyState title="No shifts" description="No shifts match this filter." />}
      />
    </div>
  );
}
```

- [ ] **Step 2: `/admin/shifts/[shiftId]` detail page**

Create `apps/web/app/(admin)/admin/shifts/[shiftId]/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { TransactionResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ShiftStatusBadge } from '@/components/admin/shifts/shift-status-badge';
import { ShiftDenominationTable } from '@/components/admin/shifts/shift-denomination-table';
import { ReviewVarianceDialog } from '@/components/admin/shifts/review-variance-dialog';
import { formatCurrency } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useShift, useShiftSummary } from '@/hooks/queries/use-shifts';
import { useTransactions } from '@/hooks/queries/use-transactions';

const TRANSACTION_STATUS_VARIANT: Record<string, 'active' | 'critical' | 'warning'> = {
  completed: 'active',
  voided: 'critical',
  refunded: 'warning',
};

export default function AdminShiftDetailPage() {
  const params = useParams<{ shiftId: string }>();
  const shiftId = params.shiftId;
  const { user } = useAuth();
  const [reviewing, setReviewing] = useState(false);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const { data: shift, isLoading: shiftLoading } = useShift(shiftId);
  const { data: summaryData } = useShiftSummary(shiftId);
  // useTransactions is `enabled: Boolean(filters.branch_id)` — passing shift.branch_id
  // once the parent shift has loaded also satisfies branchGuard for a supervisor caller.
  const { data: txData, isLoading: txLoading, isError: txError, refetch: refetchTx } = useTransactions({
    shift_id: shiftId,
    branch_id: shift?.branch_id,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<TransactionResponse>[] = [
    { id: 'created_at', header: 'Time', cell: ({ row }) => new Date(row.original.created_at).toLocaleTimeString() },
    { id: 'receipt_number', header: 'Receipt #', accessorKey: 'receipt_number' },
    {
      id: 'items',
      header: 'Items',
      cell: ({ row }) => (row.original.items ?? []).map((i) => `${i.quantity}x ${i.product_name}`).join(', '),
    },
    { id: 'payment_method', header: 'Payment', cell: ({ row }) => row.original.payment_method.toUpperCase() },
    { id: 'discount_type', header: 'Discount', cell: ({ row }) => row.original.discount_type ?? '—' },
    { id: 'total_amount', header: 'Total', cell: ({ row }) => formatCurrency(row.original.total_amount) },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => <Badge variant={TRANSACTION_STATUS_VARIANT[row.original.status]}>{row.original.status}</Badge>,
    },
  ];

  if (shiftLoading) return <p className="p-6 text-sm text-muted-foreground">Loading shift…</p>;
  if (!shift) return <p className="p-6 text-sm text-destructive">Shift not found.</p>;

  const summary = summaryData?.summary;
  const canReview = shift.status === 'flagged' && user?.role === 'super_admin';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Shift Detail</h1>
          <p className="text-sm text-muted-foreground">{shift.id}</p>
        </div>
        <div className="flex items-center gap-2">
          <ShiftStatusBadge status={shift.status} />
          {canReview && <Button onClick={() => setReviewing(true)}>Review Variance</Button>}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Shift Metadata</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div><p className="text-xs text-muted-foreground">Branch</p><p className="font-medium">{shift.branch_id}</p></div>
          <div><p className="text-xs text-muted-foreground">Cashier</p><p className="font-medium">{shift.cashier_id}</p></div>
          <div><p className="text-xs text-muted-foreground">Opened At</p><p className="font-medium">{new Date(shift.started_at).toLocaleString()}</p></div>
          <div><p className="text-xs text-muted-foreground">Closed At</p><p className="font-medium">{shift.closed_at ? new Date(shift.closed_at).toLocaleString() : '—'}</p></div>
        </CardContent>
      </Card>

      {summary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">EOD Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div><p className="text-xs text-muted-foreground">Total Sales</p><p className="font-semibold tabular-nums">{formatCurrency(summary.total_sales)}</p></div>
            <div><p className="text-xs text-muted-foreground">Cash Sales</p><p className="font-semibold tabular-nums">{formatCurrency(summary.cash_sales_total)} ({summary.cash_sales_count})</p></div>
            <div><p className="text-xs text-muted-foreground">GCash Sales</p><p className="font-semibold tabular-nums">{formatCurrency(summary.gcash_sales_total)} ({summary.gcash_sales_count})</p></div>
            <div><p className="text-xs text-muted-foreground">Total Transactions</p><p className="font-semibold tabular-nums">{summary.total_transaction_count}</p></div>
            <div><p className="text-xs text-muted-foreground">Voided</p><p className="font-semibold tabular-nums">{summary.voided_count}</p></div>
            <div><p className="text-xs text-muted-foreground">Refunded</p><p className="font-semibold tabular-nums">{summary.refunded_count}</p></div>
            <div><p className="text-xs text-muted-foreground">Total Discounts</p><p className="font-semibold tabular-nums">{formatCurrency(summary.total_discount_amount)}</p></div>
            <div><p className="text-xs text-muted-foreground">PWD/SC Transactions</p><p className="font-semibold tabular-nums">{summary.pwd_sc_transaction_count}</p></div>
            {summary.actual_cash !== null && (
              <>
                <div><p className="text-xs text-muted-foreground">Expected Cash</p><p className="font-semibold tabular-nums">{formatCurrency(summary.expected_cash)}</p></div>
                <div><p className="text-xs text-muted-foreground">Actual Cash</p><p className="font-semibold tabular-nums">{formatCurrency(summary.actual_cash)}</p></div>
                <div><p className="text-xs text-muted-foreground">Variance</p><p className={`font-semibold tabular-nums ${summary.variance !== 0 ? 'text-destructive' : ''}`}>{formatCurrency(summary.variance ?? 0)}</p></div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {shift.status === 'flagged' && (
        <Card className="border-orange-400">
          <CardHeader>
            <CardTitle className="text-sm text-orange-600">Pending Variance Review</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>Cashier's explanation: {shift.variance_explanation}</p>
            {!canReview && <p className="text-xs text-muted-foreground">Only a super admin can approve or reject this variance.</p>}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm">Opening Count</CardTitle></CardHeader>
          <CardContent><ShiftDenominationTable denominations={shift.denominations ?? []} phase="opening" /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Closing Count</CardTitle></CardHeader>
          <CardContent><ShiftDenominationTable denominations={shift.denominations ?? []} phase="closing" /></CardContent>
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Transactions</h2>
        <DataTable
          columns={columns}
          data={txData?.transactions ?? []}
          isLoading={txLoading}
          isError={txError}
          onRetry={() => void refetchTx()}
          pagination={pagination}
          onPaginationChange={setPagination}
          rowCount={txData?.total ?? 0}
          emptyState={<EmptyState title="No transactions" description="No transactions were recorded on this shift." />}
        />
      </div>

      {canReview && <ReviewVarianceDialog open={reviewing} onOpenChange={setReviewing} shift={shift} />}
    </div>
  );
}
```

- [ ] **Step 3: Add the sidebar nav item**

In `apps/web/components/admin/admin-sidebar.tsx`, add `Banknote` to the `lucide-react` import list (alongside `LayoutDashboard`, `Building2`, etc.), and add a new entry to `NAV_ITEMS` after `'Recipes'` and before the CR-001 approvals comment (matching the module ordering — cash/shifts sits with the other operational modules, not the approvals section):

```ts
  { label: 'Shifts', href: '/admin/shifts', icon: Banknote },
```

- [ ] **Step 4: Manually verify in the browser**

Start the dev server, log in as a super_admin, navigate to `/admin/shifts`, confirm the table loads with real shift data, click a row, confirm the detail page renders metadata/summary/denominations/transactions, and (if a flagged shift exists in seed/dev data) confirm the Review Variance dialog opens and an approve/reject round-trips correctly.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(admin)/admin/shifts" apps/web/components/admin/admin-sidebar.tsx
git commit -m "feat(web): add admin shifts list and detail pages"
```

---

### Task 12: Frontend — build out `/supervisor/cash`

**Files:**
- Modify: `apps/web/app/(supervisor)/supervisor/cash/page.tsx`

**Interfaces:**
- Consumes: `useShifts` (existing), `useBranchStore` (existing pattern from `supervisor/inventory/page.tsx`), `ShiftStatusBadge` (Task 10).

- [ ] **Step 1: Replace the placeholder with a branch-scoped shift list**

Replace the full contents of `apps/web/app/(supervisor)/supervisor/cash/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import type { ShiftResponse } from '@potato-corner/shared';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ShiftStatusBadge } from '@/components/admin/shifts/shift-status-badge';
import { formatCurrency } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useShifts } from '@/hooks/queries/use-shifts';

/**
 * GET /api/cash requires branch_id for non-super_admin (branchGuard) — a
 * supervisor with multiple branches switches via the sidebar's
 * BranchSelector (useBranchStore), same pattern as /supervisor/inventory.
 */
export default function SupervisorCashPage() {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const { data, isLoading, isError, refetch } = useShifts({
    branch_id: activeBranchId ?? undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<ShiftResponse>[] = [
    { id: 'opened_by', header: 'Opened By', accessorKey: 'opened_by' },
    { id: 'started_at', header: 'Opened At', cell: ({ row }) => new Date(row.original.started_at).toLocaleString() },
    { id: 'closed_at', header: 'Closed At', cell: ({ row }) => (row.original.closed_at ? new Date(row.original.closed_at).toLocaleString() : '—') },
    { id: 'status', header: 'Status', cell: ({ row }) => <ShiftStatusBadge status={row.original.status} /> },
    { id: 'total_sales', header: 'Total Sales', cell: ({ row }) => formatCurrency(row.original.cash_sales_total + row.original.gcash_sales_total) },
    {
      id: 'variance',
      header: 'Variance',
      cell: ({ row }) => (row.original.cash_variance === null ? '—' : <span className={row.original.cash_variance === 0 ? '' : 'text-destructive'}>{formatCurrency(row.original.cash_variance)}</span>),
    },
  ];

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to view its cash shifts.</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Cash Management</h1>
        <p className="text-sm text-muted-foreground">Shifts for your active branch. Click a row for the full reconciliation detail.</p>
      </div>

      <DataTable
        columns={columns}
        data={data?.shifts ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(shift) => router.push(`/admin/shifts/${shift.id}`)}
        emptyState={<EmptyState title="No shifts" description="No shifts recorded yet for this branch." />}
      />
    </div>
  );
}
```

Note: row click navigates to `/admin/shifts/:shiftId` even for a supervisor. Confirm this resolves correctly — `apps/web/middleware.ts`'s `ROLE_PATH_OWNERSHIP` restricts `/admin` to `super_admin` only (confirmed during investigation), so a supervisor would be blocked. **This needs its own detail route.** Fix it in Step 2 below rather than reusing the admin route.

- [ ] **Step 2: Add a supervisor-scoped detail route that reuses the same page body**

Create `apps/web/app/(supervisor)/supervisor/cash/[shiftId]/page.tsx` by copying `apps/web/app/(admin)/admin/shifts/[shiftId]/page.tsx`'s full contents verbatim — same component logic (it already reads `shift.status`/`user.role` to decide whether to show the Review Variance button, which correctly stays hidden for a supervisor since `canReview` checks `user?.role === 'super_admin'`).

Then in `apps/web/app/(supervisor)/supervisor/cash/page.tsx` (Step 1's file), change the `onRowClick` target:
```ts
        onRowClick={(shift) => router.push(`/supervisor/cash/${shift.id}`)}
```

- [ ] **Step 3: Manually verify in the browser**

Log in as a supervisor with an assigned branch, navigate to `/supervisor/cash`, confirm the branch selector controls which shifts load, click a row, confirm `/supervisor/cash/:shiftId` renders the same detail view without a Review Variance button (since the logged-in user isn't super_admin).

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/(supervisor)/supervisor/cash"
git commit -m "feat(web): build out supervisor cash management page and shift detail route"
```

---

### Task 13: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all previously-passing suites still pass, plus every new test added in Tasks 3–5. Record the new total test count (previous baseline: 311 passing, 102 skipped, 0 failed).

- [ ] **Step 2: Type-check**

Run: `pnpm type-check`
Expected: 0 errors across `@potato-corner/api`, `@potato-corner/web`, `@potato-corner/shared`.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 4: Production build**

Run: `pnpm build`
Expected: exit 0, confirming the phase brief's explicit "every phase should end with a confirmed green build" requirement.

- [ ] **Step 5: Report**

Summarize for the user: migration fields added (7, listed), exact final shape of both the `POST /:shiftId/close` response (`data`: flat shift + `summary`) and `GET /:shiftId/summary` response (`data: { shift, summary }`) — pointing out the deliberate shape difference and why, updated test count, the flagged ambiguities from this plan's "Resolved ambiguities" section (especially the `variance_status` collapsing point, relevant to Phase 16 reporting), and the final `pnpm build` result.

---

## Self-review notes (from the plan-writing pass)

- **Spec coverage:** Step 1 (DB) → Task 1. Step 2 (close endpoint enhancement) → Tasks 3–4, 6. Step 3 (GET summary) → Tasks 4–6. Step 4 (frontend pages) → Tasks 8–12. Step 5 (tests: Parts A–D) → Tasks 3, 4, 5, 7. Final report items (1–5) → Task 13, Step 5.
- **Casing/enum fidelity:** every field/enum value in this plan was checked against the live `packages/shared/src/constants/status.ts` and `schema.prisma` rather than the phase brief's placeholder casing — see "Global Constraints" and "Resolved ambiguities" for the specific corrections (lowercase enums, `'active'/'closed'/'flagged'` in place of `OPEN/CLOSED/PENDING_REVIEW`, `discountType` as a plain string not an enum).
- **Type consistency check:** `ShiftCloseComputedCounts` (Task 2) is used identically in Task 3's repository method return type, Task 3's `closeShift` computed param, and Task 4's `getShiftSummary`/`buildEodSummary`. `EodSummary`'s 14 keys are identical between the close-response `summary` key (Task 4) and the `GET /summary` response's `summary` key (Task 4/5) — both go through the same `buildEodSummary` function, so no drift is possible.
