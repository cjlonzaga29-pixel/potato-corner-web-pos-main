# Phase 17 — Fraud Detection Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the nightly fraud-detection engine described in Architecture doc Part 12 — all 7 rules, alert creation with dedup, `FRAUD_ALERT_CREATED` socket emission, and a Super-Admin-only manual trigger — on top of the Phase 15 review workflow that already exists.

**Architecture:** A new `apps/api/src/modules/fraud/rules/` directory holds one pure-function rule module per detection rule; a `detection.service.ts` orchestrates every branch × rule combination, dedups against open/investigating alerts, persists via `fraud.repository.ts`, and emits `notifySuperAdmin(FRAUD_ALERT_CREATED, ...)`. `fraud.queue.ts` (currently a dead stub) becomes a real BullMQ `Queue`/`Worker` pair with the codebase's first repeatable job — a nightly `0 23 * * *` (Asia/Manila) cron entry — plus a `manual_scan` job type reachable from a new `POST /api/fraud/run` endpoint. One migration adds a deterministic `discountCustomerIdHash` column (the existing `discountCustomerIdEncrypted` uses a random IV and can never be grouped/compared) and a composite dedup index.

**Tech Stack:** Express 5, Prisma 5.x/PostgreSQL, BullMQ 5.x + Upstash Redis, Zod 4, Vitest 3, Node `crypto` (HMAC-SHA256).

## Global Constraints

- TypeScript strict mode, no `any`, no `!` without a comment explaining why it's safe.
- No raw SQL anywhere — Prisma only, migrations are the one place hand-written SQL is expected (Prisma-generated DDL).
- No direct Prisma calls outside a module's own `*.repository.ts` file — this plan adds methods to `transactions.repository.ts`, `cash.repository.ts`, and `fraud.repository.ts` rather than passing a raw Prisma client into rule modules.
- snake_case in every JSON response field; camelCase in TypeScript; kebab-case file names.
- Conventional commits (`feat|fix|test|refactor`, imperative mood), one commit per step group as shown.
- `HASH_KEY` must be a required env var with no default (mirrors `ENCRYPTION_KEY`'s `z.string().min(1)`, no `.default(...)`).
- Backoff for every new BullMQ job type: `[10_000, 60_000, 300_000]` ms, `attempts: 3`, `backoff: { type: 'custom' }`, matching `inventory.queue.ts` and `report.queue.ts` exactly (Architecture doc §3.6).
- Nightly scan fires at `23:00 Asia/Manila` — deliberately before the Phase 18 EOD summary's `23:59` slot so "open fraud alerts created that day" (Architecture doc Part 13) has this run's output available.
- Every rule module is a pure function: `evaluate(context) => Promise<DetectionResult[]>`, no side effects (no writes, no socket emission) — the detection service alone owns persistence, dedup, and broadcast.

---

## Corrections from typical patterns

These deviate from what a naive reading of a "typical" fraud-engine task would assume, based on what's actually in this codebase:

1. **`fraud.queue.ts` already exists but is dead code.** It's a `Queue`/`Worker` stub with a `// TODO(Phase 8+): implement.` body. Nothing in the app currently imports it — `fraud.router.ts` → `fraud.service.ts` → `fraud.repository.ts` never reaches it, and `app.ts`/`server.ts` don't import any queue file explicitly. Task 7 rewrites the file in place (not "create new") and Task 7 also explicitly wires it into `server.ts`'s boot sequence, because there is no pre-existing "queue bootstrap" file to hook into.

2. **No repeatable/cron BullMQ job exists anywhere in this codebase today.** A grep across `apps/api/src/queues/` for `repeat:`/`cron`/`every:` returns nothing — every existing queue (`inventory`, `notification`, `report`) is triggered by an explicit one-shot `.add()` call from request-handling code. Phase 17 is the first user of BullMQ's `repeat` option in this repo; there's no in-repo pattern to copy for that specific piece, only BullMQ's own documented API (`{ repeat: { pattern, tz }, jobId }`, deduped by BullMQ itself so calling the registration function on every boot is safe).

3. **Rule modules do not receive a raw Prisma client.** Passing `prisma` directly into `RuleContext` (as a naive design might suggest) would break this codebase's one universal rule: every module's Prisma access lives inside that module's own `*.repository.ts`, never in a service, router, or (here) a rule file — see `transactions.repository.ts`, `cash.repository.ts`, `attendance.repository.ts`, `fraud.repository.ts`, all of which carry the same doc comment ("All Prisma calls for this module live here"). `RuleContext` is `{ branchId: string | null; evaluationDate: Date }`; rules call new read-only methods added to `transactionsRepository`/`cashRepository`/`fraudRepository` in Tasks 4–5. This still satisfies "pure function, no side effects" — reads aren't side effects, and no rule file writes anything or emits a socket event.

4. **Rule 5 (Discount ID reuse) cannot be evaluated per-branch.** A customer can split ID reuse across two or three different branches inside the 30-day window, so forcing it into a per-branch loop (as the other 6 rules naturally are) would miss exactly the cross-branch case the rule exists to catch, and would also make the standard `(branchId, employeeId, alertType)` dedup key from the locked decisions ambiguous (this rule has no natural `employeeId`, and `branchId` would be arbitrary). `FraudRule` gets a `scope: 'branch' | 'global'` field; the detection engine (Task 6) calls branch-scoped rules once per active branch and global-scoped rules exactly once. Rule 5 is the only `'global'` rule. Its dedup uses a dedicated path keyed on `evidence.customer_id_hash` (Task 6) instead of the standard key — every other rule uses the standard `(branchId, employeeId, alertType)` key exactly as locked.

5. **Shift-scoped rules (1, 2, 6, 7) share one repository method, not three.** Prisma's filtered relation `_count` (`_count: { select: { transactions: { where: {...} } } }`) only allows one filter per relation *name* per query — it cannot express "voided count" and "discounted count" as two different filters on the same `transactions` relation in a single call. Rather than three near-duplicate `groupBy` round trips, `transactionsRepository.findClosedShiftTransactionSummaries` fetches each closed shift together with its voided and discounted transaction rows in one query; rules 1, 2, 6, and 7 each call this same method and filter/count the returned array themselves. This means up to 4 near-identical queries per branch per night — acceptable at nightly-batch scale on a table this size, and it keeps each rule file genuinely independent and unit-testable in isolation (mock one repository function, nothing else).

6. **Manila-day boundaries, not UTC-day boundaries.** Postgres timestamps are stored as UTC; the nightly job fires at `23:00 Asia/Manila` = `15:00 UTC`. A naive `setUTCHours(0,0,0,0)` day window would be 8 hours off from the branch's actual business day. `dayBounds()` (Task 5) computes `[Manila midnight, Manila 23:59:59.999]` in UTC-instant terms explicitly.

7. **The manual-trigger endpoint delegates to `fraud.service.ts`, not just `fraud.router.ts`.** Every existing route in `fraud.router.ts` is a thin wrapper that calls into `fraudService`, and every audit-log write in this module happens in the service layer (see `investigateAlert`/`dismissAlert`/`escalateAlert`). Task 8 adds `fraudService.triggerManualScan()` (enqueue + audit log) and keeps the router handler to the same three-line shape as the other four routes, rather than inlining queue/audit-log calls directly in the router as a literal reading of "add to fraud.router.ts" might otherwise produce.

8. **A new `SOCKET_EVENTS.FRAUD_SCAN_FAILED` constant is added.** The existing `on('failed', ...)` handlers in `inventory.queue.ts`/`report.queue.ts` both emit a named socket event on permanent failure; `fraud.queue.ts` needs the same, and no existing constant fits ("fraud:alert_created" is for a created alert, not a failed scan). Added to `packages/shared/src/constants/events.ts` alongside the other Phase-17-reserved events.

---

### Task 1: Investigation + confirmation

**Files:**
- Read only — no files modified.

**Interfaces:**
- Produces: confirmation that every fact this plan depends on is still true. If any check fails, **stop and report** — do not improvise a substitute value.

- [ ] **Step 1: Confirm the Employee discount type constant**

Run:
```bash
grep -n "EMPLOYEE" "packages/shared/src/constants/status.ts"
```
Expected: a line reading `EMPLOYEE: 'employee',` inside the `DISCOUNT_TYPE` object (around line 72). Rule 7 (`rule-employee-self-discount.ts`, Task 5) filters `discountType: 'employee'` — if this string differs, stop and report before writing Task 5.

- [ ] **Step 2: Confirm `fraud.queue.ts` is still the dead stub described above**

Run:
```bash
grep -rn "fraud.queue" apps/api/src --include=*.ts
```
Expected: only `apps/api/src/queues/fraud.queue.ts` itself appears (no importers). If some other file now imports it, read that file before starting Task 7 — the bootstrap wiring in Task 7 may already partly exist.

- [ ] **Step 3: Confirm `server.ts` still has no queue imports**

Run:
```bash
grep -n "queues/" apps/api/src/server.ts
```
Expected: no matches. Task 7 adds the first one. If matches appear, read `server.ts` in full before editing it in Task 7.

- [ ] **Step 4: Confirm the current migration folder naming convention**

Run:
```bash
ls apps/api/prisma/migrations | tail -3
```
Expected: the most recent folder is `20260716000000_phase16_report_snapshots`. Task 2's migration folder will be `20260717000000_phase17_fraud_detection_hash_and_indexes` — if a same-or-later timestamp already exists, bump Task 2's timestamp forward by one second per colliding folder, in order, so migrations still apply in creation order.

- [ ] **Step 5: Confirm `Shift.varianceApproved` and `Shift.closedAt` are still nullable exactly as read**

Run:
```bash
grep -n "varianceApproved\|closedAt " apps/api/prisma/schema.prisma
```
Expected: `varianceApproved Boolean? @map("variance_approved")` and `closedAt DateTime? @map("closed_at")` inside `model Shift`. Rule 3 and Rule 6 (Task 5) depend on both being nullable with exactly these names.

No commit for this task — it's read-only confirmation.

---

### Task 2: Prisma migration — `discountCustomerIdHash` + composite dedup index

**Dependencies:** Task 1 (Step 4 confirms the migration timestamp is still free).

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260717000000_phase17_fraud_detection_hash_and_indexes/migration.sql`

**Interfaces:**
- Produces: `Transaction.discountCustomerIdHash: string | null` (Prisma field), `@@index([discountCustomerIdHash])` on `Transaction`, `@@index([branchId, alertType, status])` on `FraudAlert`. Task 3 and Task 4 depend on these existing in the generated Prisma client.

- [ ] **Step 1: Edit `schema.prisma` — add the hash column next to the existing encrypted column**

In `apps/api/prisma/schema.prisma`, inside `model Transaction`, find:
```prisma
  discountCustomerIdEncrypted String?                  @map("discount_customer_id_encrypted")
```
Replace with:
```prisma
  discountCustomerIdEncrypted String?                  @map("discount_customer_id_encrypted")
  // Deterministic HMAC-SHA256 of the same plaintext ID stored above —
  // discountCustomerIdEncrypted uses a random IV per encryption (see
  // lib/encryption.ts), so it can never be grouped/compared for equality.
  // This column exists solely so the Phase 17 discount-ID-reuse rule can
  // find repeated IDs; it is never decrypted and never returned in any API
  // response.
  discountCustomerIdHash      String?                  @map("discount_customer_id_hash")
```

- [ ] **Step 2: Edit `schema.prisma` — add the index on the new column**

In the same `model Transaction`, find:
```prisma
  @@index([branchId, createdAt])
  @@index([shiftId])
  @@index([cashierId])
  @@map("transactions")
```
Replace with:
```prisma
  @@index([branchId, createdAt])
  @@index([shiftId])
  @@index([cashierId])
  @@index([discountCustomerIdHash])
  @@map("transactions")
```

- [ ] **Step 3: Edit `schema.prisma` — add the composite dedup index to `FraudAlert`**

In `model FraudAlert`, find:
```prisma
  @@index([branchId])
  @@index([employeeId])
  @@map("fraud_alerts")
```
Replace with:
```prisma
  @@index([branchId])
  @@index([employeeId])
  @@index([branchId, alertType, status])
  @@map("fraud_alerts")
```

- [ ] **Step 4: Write the migration SQL by hand (matches this repo's convention of hand-written, additive-only migration files — see the Phase 10/16 migrations)**

Create `apps/api/prisma/migrations/20260717000000_phase17_fraud_detection_hash_and_indexes/migration.sql`:
```sql
-- Phase 17: fraud detection engine.
-- discountCustomerIdEncrypted (AES-256-GCM, random IV per row) can never be
-- grouped/compared for equality, so the discount-ID-reuse rule needs a
-- deterministic HMAC-SHA256 companion column instead. The composite index
-- on fraud_alerts supports the nightly job's per-(branch, employee, alertType)
-- dedup lookup (fraudRepository.findRecentOpenAlert).

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "discount_customer_id_hash" TEXT;

-- CreateIndex
CREATE INDEX "transactions_discount_customer_id_hash_idx" ON "transactions"("discount_customer_id_hash");

-- CreateIndex
CREATE INDEX "fraud_alerts_branch_id_alert_type_status_idx" ON "fraud_alerts"("branch_id", "alert_type", "status");
```

- [ ] **Step 5: Regenerate the Prisma client**

Run:
```bash
pnpm --filter @potato-corner/api run prisma:generate
```
Expected: `Generated Prisma Client` with no errors, and `Prisma.TransactionGetPayload<...>` / the `PrismaClient` type now include `discountCustomerIdHash`.

- [ ] **Step 6: Typecheck**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
```
Expected: passes (no code references the new field yet, so this only confirms the schema itself is valid TypeScript-generation-wise).

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260717000000_phase17_fraud_detection_hash_and_indexes/migration.sql
git commit -m "feat(db): add discountCustomerIdHash and fraud_alerts dedup index for Phase 17"
```

**Deviation protocol:** If `prisma:generate` fails because `DATABASE_URL` isn't reachable in this environment, that's expected in a sandbox without a live Postgres instance — confirm the migration SQL is syntactically valid by reading it back, note the untested-against-a-real-DB caveat in the task's completion notes, and continue; do not attempt to work around a missing database by switching to `prisma db push` or skipping the migration file.

---

### Task 3: Transaction write-path — deterministic hash for discount customer IDs

**Dependencies:** Task 2.

**Files:**
- Modify: `apps/api/src/lib/encryption.ts`
- Create: `apps/api/src/lib/encryption.test.ts`
- Modify: `apps/api/src/config/index.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/src/modules/transactions/transactions.repository.ts`
- Modify: `apps/api/src/modules/transactions/transactions.service.ts`
- Modify: `apps/api/src/modules/transactions/transactions.service.test.ts`

**Interfaces:**
- Produces: `hashField(plaintext: string): string` (deterministic, hex-encoded HMAC-SHA256), exported from `apps/api/src/lib/encryption.js`. Rule 5 (Task 5) never calls this directly — it reads the already-populated column via `transactionsRepository.findStatutoryDiscountsInWindow`.

- [ ] **Step 1: Write the failing test for `hashField`**

Create `apps/api/src/lib/encryption.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  config: {
    encryptionKey: Buffer.from('a'.repeat(32)).toString('base64'),
    hashKey: Buffer.from('b'.repeat(32)).toString('base64'),
  },
}));

const { hashField, encryptField, decryptField } = await import('./encryption.js');

describe('hashField', () => {
  it('is deterministic for the same plaintext', () => {
    expect(hashField('PWD-12345')).toBe(hashField('PWD-12345'));
  });

  it('produces different output for different plaintext', () => {
    expect(hashField('PWD-12345')).not.toBe(hashField('PWD-99999'));
  });

  it('returns a 64-character lowercase hex string (SHA-256 digest)', () => {
    const result = hashField('PWD-12345');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent from encryptField — encrypting twice differs, hashing twice does not', () => {
    const encryptedA = encryptField('PWD-12345');
    const encryptedB = encryptField('PWD-12345');
    expect(encryptedA).not.toBe(encryptedB);
    expect(decryptField(encryptedA)).toBe('PWD-12345');
    expect(hashField('PWD-12345')).toBe(hashField('PWD-12345'));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/lib/encryption.test.ts
```
Expected: FAIL — `hashField is not a function` / `does not provide an export named 'hashField'`.

- [ ] **Step 3: Implement `hashField` in `encryption.ts`**

In `apps/api/src/lib/encryption.ts`, change the top import line and add the function:
```ts
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';
```
Then, after `getKey()`, add:
```ts
function getHashKey(): Buffer {
  return Buffer.from(config.hashKey, 'base64');
}

/**
 * Deterministic HMAC-SHA256 of a plaintext ID, hex-encoded. Used only for
 * equality-matching (Phase 17's discount-ID-reuse rule) — never for
 * confidentiality, and never decrypted or reversed. Kept as a separate key
 * (HASH_KEY, not ENCRYPTION_KEY) so rotating one does not invalidate the
 * other.
 */
export function hashField(plaintext: string): string {
  return createHmac('sha256', getHashKey()).update(plaintext, 'utf8').digest('hex');
}
```

- [ ] **Step 4: Run it to verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/lib/encryption.test.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Add `HASH_KEY` to the env schema**

In `apps/api/src/config/index.ts`, in `envSchema`, find:
```ts
  ENCRYPTION_KEY: z.string().min(1),
```
Replace with:
```ts
  ENCRYPTION_KEY: z.string().min(1),
  HASH_KEY: z.string().min(1),
```
Then in the exported `config` object, find:
```ts
  encryptionKey: env.ENCRYPTION_KEY,
```
Replace with:
```ts
  encryptionKey: env.ENCRYPTION_KEY,
  hashKey: env.HASH_KEY,
```

- [ ] **Step 6: Add `HASH_KEY` to `.env.example`**

In `apps/api/.env.example`, find:
```
# Encryption
ENCRYPTION_KEY=your_32_byte_hex_encryption_key_here
```
Replace with:
```
# Encryption
ENCRYPTION_KEY=your_32_byte_hex_encryption_key_here
HASH_KEY=your_32_byte_base64_hmac_key_here
```

- [ ] **Step 7: Add `discountCustomerIdHash` to `transactionsRepository.createTransaction`**

In `apps/api/src/modules/transactions/transactions.repository.ts`, in the `CreateTransactionRow` interface, find:
```ts
  discountType: string | null;
  discountCustomerIdEncrypted: string | null;
```
Replace with:
```ts
  discountType: string | null;
  discountCustomerIdEncrypted: string | null;
  discountCustomerIdHash: string | null;
```
Then in `createTransaction`'s `tx.transaction.create({ data: { ... } })` call, find:
```ts
          discountType: data.discountType,
          discountCustomerIdEncrypted: data.discountCustomerIdEncrypted,
```
Replace with:
```ts
          discountType: data.discountType,
          discountCustomerIdEncrypted: data.discountCustomerIdEncrypted,
          discountCustomerIdHash: data.discountCustomerIdHash,
```

- [ ] **Step 8: Write the failing test for the service populating the hash**

In `apps/api/src/modules/transactions/transactions.service.test.ts`, change the encryption mock:
```ts
vi.mock('../../lib/encryption.js', () => ({
  encryptField: vi.fn((value: string) => `encrypted(${value})`),
  hashField: vi.fn((value: string) => `hashed(${value})`),
}));
```
Then add a new `describe` block (place it near the other `createTransaction` describe blocks — search the file for `describe('transactionsService.createTransaction'` to find the right neighborhood):
```ts
describe('transactionsService.createTransaction — discount ID hashing', () => {
  it('populates discountCustomerIdHash alongside the encrypted field for a PWD discount', async () => {
    vi.mocked(transactionsRepository.findBranch).mockResolvedValue({ id: 'branch-1', code: 'MNL001', status: 'active' } as never);
    vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-1', status: 'active' } as never);
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow()] as never);
    vi.mocked(transactionsRepository.findBranchProductAvailabilityMap).mockResolvedValue([{ productId: 'product-1', isAvailable: true }] as never);
    vi.mocked(priceOverridesService.getActivePriceForBranch).mockResolvedValue(100);
    vi.mocked(transactionsRepository.countTransactionsWithPrefix).mockResolvedValue(0);
    vi.mocked(transactionsRepository.createTransaction).mockResolvedValue(transactionRow({ discountType: 'pwd' }) as never);

    await transactionsService.createTransaction(
      {
        branchId: 'branch-1',
        shiftId: 'shift-1',
        cashierId: 'user-1',
        items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1 }],
        paymentMethod: 'cash',
        discountType: 'pwd',
        discountIdReference: 'PWD-12345',
        cashTendered: 200,
        isOfflineTransaction: false,
      },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        discountCustomerIdEncrypted: 'encrypted(PWD-12345)',
        discountCustomerIdHash: 'hashed(PWD-12345)',
      }),
    );
  });

  it('leaves discountCustomerIdHash null when there is no discount ID reference', async () => {
    vi.mocked(transactionsRepository.findBranch).mockResolvedValue({ id: 'branch-1', code: 'MNL001', status: 'active' } as never);
    vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-1', status: 'active' } as never);
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow()] as never);
    vi.mocked(transactionsRepository.findBranchProductAvailabilityMap).mockResolvedValue([{ productId: 'product-1', isAvailable: true }] as never);
    vi.mocked(priceOverridesService.getActivePriceForBranch).mockResolvedValue(100);
    vi.mocked(transactionsRepository.countTransactionsWithPrefix).mockResolvedValue(0);
    vi.mocked(transactionsRepository.createTransaction).mockResolvedValue(transactionRow() as never);

    await transactionsService.createTransaction(
      {
        branchId: 'branch-1',
        shiftId: 'shift-1',
        cashierId: 'user-1',
        items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1 }],
        paymentMethod: 'cash',
        cashTendered: 200,
        isOfflineTransaction: false,
      },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ discountCustomerIdEncrypted: null, discountCustomerIdHash: null }),
    );
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/transactions/transactions.service.test.ts
```
Expected: FAIL on the new `describe` block — `discountCustomerIdHash` is `undefined` in the call, not `'hashed(PWD-12345)'`/`null`.

- [ ] **Step 10: Implement in `transactions.service.ts`**

Import `hashField`:
```ts
import { encryptField, hashField } from '../../lib/encryption.js';
```
Find:
```ts
    const discountCustomerIdEncrypted = data.discountIdReference ? encryptField(data.discountIdReference) : null;
```
Replace with:
```ts
    const discountCustomerIdEncrypted = data.discountIdReference ? encryptField(data.discountIdReference) : null;
    const discountCustomerIdHash = data.discountIdReference ? hashField(data.discountIdReference) : null;
```
Find, inside the `transactionsRepository.createTransaction({...})` call:
```ts
          discountType: data.discountType ?? null,
          discountCustomerIdEncrypted,
```
Replace with:
```ts
          discountType: data.discountType ?? null,
          discountCustomerIdEncrypted,
          discountCustomerIdHash,
```

- [ ] **Step 11: Run it to verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/transactions/transactions.service.test.ts src/lib/encryption.test.ts
```
Expected: PASS, all tests including the 2 new ones.

- [ ] **Step 12: Typecheck**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
```
Expected: passes.

- [ ] **Step 13: Commit**

```bash
git add apps/api/src/lib/encryption.ts apps/api/src/lib/encryption.test.ts apps/api/src/config/index.ts apps/api/.env.example apps/api/src/modules/transactions/transactions.repository.ts apps/api/src/modules/transactions/transactions.service.ts apps/api/src/modules/transactions/transactions.service.test.ts
git commit -m "feat(transactions): populate deterministic discountCustomerIdHash for statutory discounts"
```

**Deviation protocol:** If `transactionRow()`/`variantRow()` helpers in `transactions.service.test.ts` have different field names than shown (the file may have evolved since this plan's investigation), read the actual helpers before writing Step 8's test and adapt field names — the assertion shape (`expect.objectContaining({ discountCustomerIdEncrypted, discountCustomerIdHash })`) is what matters, not the exact fixture builder syntax.

---

### Task 4: Fraud repository additions

**Dependencies:** Task 2 (schema has the new fields/index).

**Files:**
- Modify: `apps/api/src/modules/fraud/fraud.repository.ts`
- Modify: `apps/api/src/modules/fraud/fraud.repository.test.ts`
- Modify: `apps/api/src/modules/fraud/fraud.types.ts`

**Interfaces:**
- Consumes: `Prisma.FraudAlertCreateInput`-shaped data (from `@prisma/client`, already imported in this file).
- Produces:
  - `fraudRepository.createAlert(data: CreateFraudAlertData): Promise<FraudAlertRow>`
  - `fraudRepository.findRecentOpenAlert(branchId: string | null, employeeId: string | null, alertType: string): Promise<FraudAlertRow | null>`
  - `fraudRepository.findOpenAlertsByType(alertType: string): Promise<{ id: string; evidence: unknown }[]>`
  - `fraudRepository.findActiveBranchIds(): Promise<{ id: string }[]>`
  - `CreateFraudAlertData` type, exported from `fraud.types.ts`.
  Task 6's `detection.service.ts` calls all four.

- [ ] **Step 1: Add `CreateFraudAlertData` to `fraud.types.ts`**

In `apps/api/src/modules/fraud/fraud.types.ts`, after the `UpdateFraudAlertStatusData` interface at the end of the file, add:
```ts

/** Input shape for fraudRepository.createAlert — one row per detection result the engine produces. */
export interface CreateFraudAlertData {
  alertType: string;
  severity: FraudAlertSeverity;
  branchId: string | null;
  employeeId: string | null;
  evidence: Record<string, unknown>;
}
```

- [ ] **Step 2: Write the failing tests**

In `apps/api/src/modules/fraud/fraud.repository.test.ts`, extend the `vi.mock('../../lib/prisma.js', ...)` block's `prismaMock` object:
```ts
vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    fraudAlert: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
    branch: {
      findMany: vi.fn(),
    },
  };
  return { prisma: prismaMock };
});
```
Then, at the end of the file (after the `findEmployeeNamesByIds` describe block), add:
```ts
describe('fraudRepository.createAlert', () => {
  it('creates a fraud alert with the branch relation included', async () => {
    vi.mocked(prisma.fraudAlert.create).mockResolvedValue({ id: 'alert-new' } as never);

    const result = await fraudRepository.createAlert({
      alertType: 'excessive_voids',
      severity: 'medium',
      branchId: 'branch-1',
      employeeId: 'user-1',
      evidence: { shift_id: 'shift-1', void_count: 4 },
    });

    expect(prisma.fraudAlert.create).toHaveBeenCalledWith({
      data: {
        alertType: 'excessive_voids',
        severity: 'medium',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: { shift_id: 'shift-1', void_count: 4 },
      },
      include: FRAUD_ALERT_INCLUDE,
    });
    expect(result).toEqual({ id: 'alert-new' });
  });
});

describe('fraudRepository.findRecentOpenAlert', () => {
  it('queries by branchId, employeeId, alertType, and status open/investigating', async () => {
    vi.mocked(prisma.fraudAlert.findFirst).mockResolvedValue(null);

    await fraudRepository.findRecentOpenAlert('branch-1', 'user-1', 'excessive_voids');

    expect(prisma.fraudAlert.findFirst).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', employeeId: 'user-1', alertType: 'excessive_voids', status: { in: ['open', 'investigating'] } },
    });
  });

  it('returns null when nothing matches', async () => {
    vi.mocked(prisma.fraudAlert.findFirst).mockResolvedValue(null);

    const result = await fraudRepository.findRecentOpenAlert('branch-1', null, 'cash_variance_pattern');

    expect(result).toBeNull();
  });
});

describe('fraudRepository.findOpenAlertsByType', () => {
  it('selects only id and evidence for the given alertType, status open/investigating', async () => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([{ id: 'alert-1', evidence: { customer_id_hash: 'abc' } }] as never);

    const result = await fraudRepository.findOpenAlertsByType('discount_id_reuse');

    expect(prisma.fraudAlert.findMany).toHaveBeenCalledWith({
      where: { alertType: 'discount_id_reuse', status: { in: ['open', 'investigating'] } },
      select: { id: true, evidence: true },
    });
    expect(result).toEqual([{ id: 'alert-1', evidence: { customer_id_hash: 'abc' } }]);
  });
});

describe('fraudRepository.findActiveBranchIds', () => {
  it('selects only id for active branches', async () => {
    vi.mocked(prisma.branch.findMany).mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }] as never);

    const result = await fraudRepository.findActiveBranchIds();

    expect(prisma.branch.findMany).toHaveBeenCalledWith({ where: { status: 'active' }, select: { id: true } });
    expect(result).toEqual([{ id: 'branch-1' }, { id: 'branch-2' }]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/fraud.repository.test.ts
```
Expected: FAIL — `fraudRepository.createAlert is not a function` (and similarly for the other three).

- [ ] **Step 4: Implement in `fraud.repository.ts`**

Add these four methods to the `fraudRepository` object (after `findEmployeeNamesByIds`, before the closing `};`):
```ts

  createAlert(data: CreateFraudAlertData) {
    return prisma.fraudAlert.create({
      data: {
        alertType: data.alertType,
        severity: data.severity,
        branchId: data.branchId,
        employeeId: data.employeeId,
        evidence: data.evidence as Prisma.InputJsonValue,
      },
      include: fraudAlertInclude,
    });
  },

  /** Standard dedup lookup for every rule except discount_id_reuse (see findOpenAlertsByType). */
  findRecentOpenAlert(branchId: string | null, employeeId: string | null, alertType: string) {
    return prisma.fraudAlert.findFirst({
      where: { branchId, employeeId, alertType, status: { in: ['open', 'investigating'] } },
    });
  },

  /**
   * discount_id_reuse has no natural employeeId/branchId to key dedup on
   * (Corrections #4) — the detection service fetches every open alert of
   * this type and matches on evidence.customer_id_hash itself.
   */
  findOpenAlertsByType(alertType: string) {
    return prisma.fraudAlert.findMany({
      where: { alertType, status: { in: ['open', 'investigating'] } },
      select: { id: true, evidence: true },
    });
  },

  findActiveBranchIds() {
    return prisma.branch.findMany({ where: { status: 'active' }, select: { id: true } });
  },
```
And update the import line to bring in `CreateFraudAlertData`:
```ts
import type { CreateFraudAlertData, FraudAlertFilters, UpdateFraudAlertStatusData } from './fraud.types.js';
```

- [ ] **Step 5: Run it to verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/fraud.repository.test.ts
```
Expected: PASS, all tests including the 5 new ones.

- [ ] **Step 6: Typecheck**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
```
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/fraud/fraud.repository.ts apps/api/src/modules/fraud/fraud.repository.test.ts apps/api/src/modules/fraud/fraud.types.ts
git commit -m "feat(fraud): add repository methods for alert creation and dedup lookups"
```

**Deviation protocol:** If `Prisma.InputJsonValue` is not assignable from a plain `Record<string, unknown>` under this project's TS config, use `data.evidence as unknown as Prisma.InputJsonValue` instead of the single `as` cast — do not loosen the `CreateFraudAlertData.evidence` type to `any`.

---

### Task 5: Rule implementation modules

**Dependencies:** Task 1 (Step 1 confirms `'employee'`), Task 3 (hash column populated), Task 4 (not required for rules themselves, but `fraud-rule.types.ts` mirrors `CreateFraudAlertData`'s shape).

**Files:**
- Modify: `apps/api/src/modules/transactions/transactions.repository.ts`
- Modify: `apps/api/src/modules/transactions/transactions.repository.test.ts`
- Modify: `apps/api/src/modules/cash/cash.repository.ts`
- Modify: `apps/api/src/modules/cash/cash.repository.test.ts`
- Create: `apps/api/src/modules/fraud/rules/fraud-rule.types.ts`
- Create: `apps/api/src/modules/fraud/rules/fraud-rule.utils.ts`
- Create: `apps/api/src/modules/fraud/rules/fraud-rule.utils.test.ts`
- Create: `apps/api/src/modules/fraud/rules/rule-excessive-voids.ts` + `.test.ts`
- Create: `apps/api/src/modules/fraud/rules/rule-discount-abuse.ts` + `.test.ts`
- Create: `apps/api/src/modules/fraud/rules/rule-cash-variance-pattern.ts` + `.test.ts`
- Create: `apps/api/src/modules/fraud/rules/rule-gcash-volume-anomaly.ts` + `.test.ts`
- Create: `apps/api/src/modules/fraud/rules/rule-discount-id-reuse.ts` + `.test.ts`
- Create: `apps/api/src/modules/fraud/rules/rule-end-of-shift-void.ts` + `.test.ts`
- Create: `apps/api/src/modules/fraud/rules/rule-employee-self-discount.ts` + `.test.ts`
- Create: `apps/api/src/modules/fraud/rules/index.ts`

**Interfaces:**
- Consumes: `FRAUD_ALERT_SEVERITY` from `@potato-corner/shared`; new repository methods added in this task.
- Produces: `RuleContext`, `DetectionResult`, `FraudRule` types (`fraud-rule.types.ts`); `dayBounds(evaluationDate: Date): { dayStart: Date; dayEnd: Date }` (`fraud-rule.utils.ts`); `FRAUD_RULES: FraudRule[]` (`rules/index.ts`). Task 6's `detection.service.ts` imports `FRAUD_RULES` and both types.

#### Step group A — shared types and utils

- [ ] **Step 1: Create `fraud-rule.types.ts`**

```ts
import type { FraudAlertSeverity } from '@potato-corner/shared';

export interface RuleContext {
  /** null only for a 'global' scope rule (currently just discount_id_reuse). */
  branchId: string | null;
  evaluationDate: Date;
}

export interface DetectionResult {
  alertType: string;
  severity: FraudAlertSeverity;
  branchId: string | null;
  employeeId: string | null;
  evidence: Record<string, unknown>;
}

export interface FraudRule {
  /** 'branch': the detection engine calls evaluate() once per active branch. 'global': called exactly once, with branchId: null. */
  scope: 'branch' | 'global';
  evaluate(context: RuleContext): Promise<DetectionResult[]>;
}
```

- [ ] **Step 2: Write the failing test for `dayBounds`**

Create `apps/api/src/modules/fraud/rules/fraud-rule.utils.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { dayBounds } from './fraud-rule.utils.js';

describe('dayBounds', () => {
  it('returns the Manila-calendar-day window in UTC instants for a run that fires at 23:00 Manila', () => {
    // 2026-07-17T15:00:00.000Z == 2026-07-17T23:00:00+08:00 (the nightly job's fire time)
    const evaluationDate = new Date('2026-07-17T15:00:00.000Z');

    const { dayStart, dayEnd } = dayBounds(evaluationDate);

    // 2026-07-17T00:00:00+08:00 == 2026-07-16T16:00:00.000Z
    expect(dayStart.toISOString()).toBe('2026-07-16T16:00:00.000Z');
    // 2026-07-17T23:59:59.999+08:00 == 2026-07-17T15:59:59.999Z
    expect(dayEnd.toISOString()).toBe('2026-07-17T15:59:59.999Z');
  });

  it('produces a window exactly 24 hours (minus 1ms) wide', () => {
    const { dayStart, dayEnd } = dayBounds(new Date('2026-01-01T00:00:00.000Z'));
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/rules/fraud-rule.utils.test.ts
```
Expected: FAIL — cannot find module `./fraud-rule.utils.js`.

- [ ] **Step 4: Implement `fraud-rule.utils.ts`**

```ts
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * The nightly job fires at 23:00 Asia/Manila (15:00 UTC); Postgres stores
 * UTC timestamps. A naive UTC-midnight window would be 8 hours off from the
 * branch's actual business day, so this computes the Manila calendar-day
 * window explicitly: [Manila 00:00:00.000, Manila 23:59:59.999], expressed
 * as UTC instants for use in Prisma date-range filters.
 */
export function dayBounds(evaluationDate: Date): { dayStart: Date; dayEnd: Date } {
  const manilaTime = new Date(evaluationDate.getTime() + MANILA_OFFSET_MS);
  const manilaDayStartUtcMs =
    Date.UTC(manilaTime.getUTCFullYear(), manilaTime.getUTCMonth(), manilaTime.getUTCDate()) - MANILA_OFFSET_MS;
  return {
    dayStart: new Date(manilaDayStartUtcMs),
    dayEnd: new Date(manilaDayStartUtcMs + 24 * 60 * 60 * 1000 - 1),
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/rules/fraud-rule.utils.test.ts
```
Expected: PASS, 2 tests.

#### Step group B — repository methods for rules 1, 2, 6, 7 (shift-scoped, transaction data)

- [ ] **Step 6: Write the failing test**

In `apps/api/src/modules/transactions/transactions.repository.test.ts`, add `shift: { findMany: vi.fn() }` to the mocked `prismaMock`, then add:
```ts
describe('transactionsRepository.findClosedShiftTransactionSummaries', () => {
  it('fetches shifts closed in the window with their voided and discounted transactions', async () => {
    vi.mocked(prisma.shift.findMany).mockResolvedValue([]);

    const dayStart = new Date('2026-07-16T16:00:00.000Z');
    const dayEnd = new Date('2026-07-17T15:59:59.999Z');
    await transactionsRepository.findClosedShiftTransactionSummaries('branch-1', dayStart, dayEnd);

    expect(prisma.shift.findMany).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', status: { in: ['closed', 'flagged'] }, closedAt: { gte: dayStart, lte: dayEnd } },
      select: {
        id: true,
        cashierId: true,
        closedAt: true,
        transactions: {
          where: { OR: [{ status: 'voided' }, { status: 'completed', discountType: { not: null } }] },
          select: { id: true, status: true, discountType: true, voidedAt: true },
        },
      },
    });
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/transactions/transactions.repository.test.ts
```
Expected: FAIL — `transactionsRepository.findClosedShiftTransactionSummaries is not a function`.

- [ ] **Step 8: Implement in `transactions.repository.ts`**

Add to the `transactionsRepository` object (after `markReceiptPrinted`, before the closing `};`):
```ts

  /**
   * One row per shift closed inside [dayStart, dayEnd], with its voided
   * transactions and its discounted-and-completed transactions. Backs
   * fraud rules 1 (excessive voids), 2 (discount abuse), 6 (end of shift
   * void), and 7 (employee self-discount frequency) — each rule filters
   * this same shape differently rather than four near-duplicate queries.
   */
  findClosedShiftTransactionSummaries(branchId: string, dayStart: Date, dayEnd: Date) {
    return prisma.shift.findMany({
      where: { branchId, status: { in: ['closed', 'flagged'] }, closedAt: { gte: dayStart, lte: dayEnd } },
      select: {
        id: true,
        cashierId: true,
        closedAt: true,
        transactions: {
          where: { OR: [{ status: 'voided' }, { status: 'completed', discountType: { not: null } }] },
          select: { id: true, status: true, discountType: true, voidedAt: true },
        },
      },
    });
  },

  /** Per-cashier GCash transaction count for one day — the "actual" side of rule 4's anomaly comparison. */
  async findGcashCountsByCashierForDate(branchId: string, dayStart: Date, dayEnd: Date) {
    const rows = await prisma.transaction.groupBy({
      by: ['cashierId'],
      where: { branchId, paymentMethod: 'gcash', status: 'completed', createdAt: { gte: dayStart, lte: dayEnd } },
      _count: { _all: true },
    });
    return rows.map((row) => ({ cashierId: row.cashierId, gcashCount: row._count._all }));
  },

  /** Total branch-wide GCash transaction count over a trailing window — the denominator for rule 4's daily average. */
  countGcashTransactionsForBranchWindow(branchId: string, windowStart: Date, windowEnd: Date) {
    return prisma.transaction.count({
      where: { branchId, paymentMethod: 'gcash', status: 'completed', createdAt: { gte: windowStart, lte: windowEnd } },
    });
  },

  /** Every statutory-discount transaction with a hash in the trailing window, across all branches — rule 5 groups these by hash itself (Corrections #4: this rule is global-scope, not per-branch). */
  findStatutoryDiscountsInWindow(windowStart: Date, windowEnd: Date) {
    return prisma.transaction.findMany({
      where: {
        status: 'completed',
        discountType: { in: ['pwd', 'senior_citizen'] },
        discountCustomerIdHash: { not: null },
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: { id: true, branchId: true, cashierId: true, discountCustomerIdHash: true, createdAt: true },
    });
  },
```

- [ ] **Step 9: Run it to verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/transactions/transactions.repository.test.ts
```
Expected: PASS, all tests including the new one.

- [ ] **Step 10: Write and pass tests for the remaining three new methods**

Add to the same test file:
```ts
describe('transactionsRepository.findGcashCountsByCashierForDate', () => {
  it('groups completed GCash transactions by cashierId', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([{ cashierId: 'user-1', _count: { _all: 6 } }] as never);

    const dayStart = new Date('2026-07-16T16:00:00.000Z');
    const dayEnd = new Date('2026-07-17T15:59:59.999Z');
    const result = await transactionsRepository.findGcashCountsByCashierForDate('branch-1', dayStart, dayEnd);

    expect(prisma.transaction.groupBy).toHaveBeenCalledWith({
      by: ['cashierId'],
      where: { branchId: 'branch-1', paymentMethod: 'gcash', status: 'completed', createdAt: { gte: dayStart, lte: dayEnd } },
      _count: { _all: true },
    });
    expect(result).toEqual([{ cashierId: 'user-1', gcashCount: 6 }]);
  });
});

describe('transactionsRepository.countGcashTransactionsForBranchWindow', () => {
  it('counts completed GCash transactions in the window', async () => {
    vi.mocked(prisma.transaction.count).mockResolvedValue(120);

    const windowStart = new Date('2026-06-17T16:00:00.000Z');
    const windowEnd = new Date('2026-07-17T15:59:59.999Z');
    const result = await transactionsRepository.countGcashTransactionsForBranchWindow('branch-1', windowStart, windowEnd);

    expect(prisma.transaction.count).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', paymentMethod: 'gcash', status: 'completed', createdAt: { gte: windowStart, lte: windowEnd } },
    });
    expect(result).toBe(120);
  });
});

describe('transactionsRepository.findStatutoryDiscountsInWindow', () => {
  it('finds completed PWD/Senior transactions with a non-null hash in the window, across all branches', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);

    const windowStart = new Date('2026-06-17T16:00:00.000Z');
    const windowEnd = new Date('2026-07-17T15:59:59.999Z');
    await transactionsRepository.findStatutoryDiscountsInWindow(windowStart, windowEnd);

    expect(prisma.transaction.findMany).toHaveBeenCalledWith({
      where: {
        status: 'completed',
        discountType: { in: ['pwd', 'senior_citizen'] },
        discountCustomerIdHash: { not: null },
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: { id: true, branchId: true, cashierId: true, discountCustomerIdHash: true, createdAt: true },
    });
  });
});
```
Add `transaction: { ..., groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() }` fields to the mocked `prismaMock.transaction` object if not already present (the existing mock already has `count` and likely `findMany`; add `groupBy` if missing).

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/transactions/transactions.repository.test.ts
```
Expected: PASS, all tests.

- [ ] **Step 11: Typecheck, then commit**

```bash
pnpm --filter @potato-corner/api run type-check
git add apps/api/src/modules/transactions/transactions.repository.ts apps/api/src/modules/transactions/transactions.repository.test.ts
git commit -m "feat(transactions): add repository queries for fraud rules 1/2/4/5/6/7"
```

#### Step group C — repository methods for rule 3 (cash variance pattern)

- [ ] **Step 12: Write the failing tests**

In `apps/api/src/modules/cash/cash.repository.test.ts`, add `shift: { findMany: vi.fn(), ... (existing) }` entries as needed, then add:
```ts
describe('cashRepository.findCashiersWithClosedShifts', () => {
  it('returns distinct cashierIds for shifts closed in the window', async () => {
    vi.mocked(prisma.shift.findMany).mockResolvedValue([{ cashierId: 'user-1' }, { cashierId: 'user-2' }] as never);

    const dayStart = new Date('2026-07-16T16:00:00.000Z');
    const dayEnd = new Date('2026-07-17T15:59:59.999Z');
    const result = await cashRepository.findCashiersWithClosedShifts('branch-1', dayStart, dayEnd);

    expect(prisma.shift.findMany).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', status: { in: ['closed', 'flagged'] }, closedAt: { gte: dayStart, lte: dayEnd } },
      select: { cashierId: true },
      distinct: ['cashierId'],
    });
    expect(result).toEqual(['user-1', 'user-2']);
  });
});

describe('cashRepository.findLastNClosedShiftsForCashier', () => {
  it('fetches the N most recently closed shifts for one cashier at one branch', async () => {
    vi.mocked(prisma.shift.findMany).mockResolvedValue([]);

    await cashRepository.findLastNClosedShiftsForCashier('user-1', 'branch-1', 10);

    expect(prisma.shift.findMany).toHaveBeenCalledWith({
      where: { cashierId: 'user-1', branchId: 'branch-1', status: { in: ['closed', 'flagged'] } },
      orderBy: { closedAt: 'desc' },
      take: 10,
      select: { id: true, varianceApproved: true, closedAt: true },
    });
  });
});
```
Note: `cash.repository.ts` already imports `prisma` from `../../lib/prisma.js` and the test file already mocks `prisma.shift` for `findFirst`/`findUnique`/etc. — add `findMany: vi.fn()` to that existing mock object if it isn't already there (check the file first; do not create a second `vi.mock('../../lib/prisma.js', ...)` block).

- [ ] **Step 13: Run it to verify it fails**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/cash/cash.repository.test.ts
```
Expected: FAIL — both methods undefined.

- [ ] **Step 14: Implement in `cash.repository.ts`**

Add to the `cashRepository` object (after `listShifts`, before the closing `};`):
```ts

  /** Distinct cashiers who closed a shift in the window — the candidate set rule 3 (cash variance pattern) checks. */
  async findCashiersWithClosedShifts(branchId: string, dayStart: Date, dayEnd: Date): Promise<string[]> {
    const rows = await prisma.shift.findMany({
      where: { branchId, status: { in: ['closed', 'flagged'] }, closedAt: { gte: dayStart, lte: dayEnd } },
      select: { cashierId: true },
      distinct: ['cashierId'],
    });
    return rows.map((row) => row.cashierId);
  },

  /** The trailing window rule 3 evaluates: varianceApproved !== null (Decision 6) means "outside tolerance, required a decision". */
  findLastNClosedShiftsForCashier(cashierId: string, branchId: string, n: number) {
    return prisma.shift.findMany({
      where: { cashierId, branchId, status: { in: ['closed', 'flagged'] } },
      orderBy: { closedAt: 'desc' },
      take: n,
      select: { id: true, varianceApproved: true, closedAt: true },
    });
  },
```

- [ ] **Step 15: Run it to verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/cash/cash.repository.test.ts
```
Expected: PASS, all tests including the 2 new ones.

- [ ] **Step 16: Typecheck, then commit**

```bash
pnpm --filter @potato-corner/api run type-check
git add apps/api/src/modules/cash/cash.repository.ts apps/api/src/modules/cash/cash.repository.test.ts
git commit -m "feat(cash): add repository queries for the cash-variance-pattern fraud rule"
```

#### Step group D — the 7 rule modules

Each rule below follows the same TDD shape: write the test (mocking only the repository method(s) it calls), watch it fail, implement, watch it pass, typecheck, commit. Full code is given for every rule and every test file — apply the same Step 1→5 pattern shown in full for Rule 1 to Rules 2 through 7, substituting the code blocks given.

- [ ] **Step 17: Rule 1 — `rule-excessive-voids.ts`**

Test — create `apps/api/src/modules/fraud/rules/rule-excessive-voids.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../transactions/transactions.repository.js', () => ({
  transactionsRepository: { findClosedShiftTransactionSummaries: vi.fn() },
}));

const { transactionsRepository } = await import('../../transactions/transactions.repository.js');
const { excessiveVoidsRule } = await import('./rule-excessive-voids.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('excessiveVoidsRule', () => {
  it('is a branch-scoped rule', () => {
    expect(excessiveVoidsRule.scope).toBe('branch');
  });

  it('returns [] when called with branchId: null', async () => {
    const result = await excessiveVoidsRule.evaluate({ branchId: null, evaluationDate: new Date() });
    expect(result).toEqual([]);
    expect(transactionsRepository.findClosedShiftTransactionSummaries).not.toHaveBeenCalled();
  });

  it('flags a shift with more than 3 voided transactions', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      {
        id: 'shift-1',
        cashierId: 'user-1',
        closedAt: new Date('2026-07-17T10:00:00.000Z'),
        transactions: [
          { id: 'txn-1', status: 'voided', discountType: null, voidedAt: new Date() },
          { id: 'txn-2', status: 'voided', discountType: null, voidedAt: new Date() },
          { id: 'txn-3', status: 'voided', discountType: null, voidedAt: new Date() },
          { id: 'txn-4', status: 'voided', discountType: null, voidedAt: new Date() },
        ],
      },
    ] as never);

    const result = await excessiveVoidsRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date('2026-07-17T15:00:00.000Z') });

    expect(result).toEqual([
      {
        alertType: 'excessive_voids',
        severity: 'medium',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: { shift_id: 'shift-1', void_count: 4, void_transaction_ids: ['txn-1', 'txn-2', 'txn-3', 'txn-4'] },
      },
    ]);
  });

  it('does not flag a shift with exactly 3 voided transactions (threshold is >3)', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      {
        id: 'shift-1',
        cashierId: 'user-1',
        closedAt: new Date(),
        transactions: [
          { id: 'txn-1', status: 'voided', discountType: null, voidedAt: new Date() },
          { id: 'txn-2', status: 'voided', discountType: null, voidedAt: new Date() },
          { id: 'txn-3', status: 'voided', discountType: null, voidedAt: new Date() },
        ],
      },
    ] as never);

    const result = await excessiveVoidsRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
```

Implementation — create `apps/api/src/modules/fraud/rules/rule-excessive-voids.ts`:
```ts
import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { transactionsRepository } from '../../transactions/transactions.repository.js';
import { dayBounds } from './fraud-rule.utils.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12: "Excessive voids — >3 voids in one shift — Medium". */
const VOID_THRESHOLD = 3;

export const excessiveVoidsRule: FraudRule = {
  scope: 'branch',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    if (!context.branchId) return [];
    const { dayStart, dayEnd } = dayBounds(context.evaluationDate);
    const shifts = await transactionsRepository.findClosedShiftTransactionSummaries(context.branchId, dayStart, dayEnd);

    const results: DetectionResult[] = [];
    for (const shift of shifts) {
      const voidedIds = shift.transactions.filter((t) => t.status === 'voided').map((t) => t.id);
      if (voidedIds.length <= VOID_THRESHOLD) continue;
      results.push({
        alertType: 'excessive_voids',
        severity: FRAUD_ALERT_SEVERITY.MEDIUM,
        branchId: context.branchId,
        employeeId: shift.cashierId,
        evidence: { shift_id: shift.id, void_count: voidedIds.length, void_transaction_ids: voidedIds },
      });
    }
    return results;
  },
};
```

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/rules/rule-excessive-voids.test.ts
```
Expected: FAIL first (module not found), then PASS (4 tests) after implementing.

Commit:
```bash
git add apps/api/src/modules/fraud/rules/rule-excessive-voids.ts apps/api/src/modules/fraud/rules/rule-excessive-voids.test.ts apps/api/src/modules/fraud/rules/fraud-rule.types.ts apps/api/src/modules/fraud/rules/fraud-rule.utils.ts apps/api/src/modules/fraud/rules/fraud-rule.utils.test.ts
git commit -m "feat(fraud): implement excessive-voids detection rule"
```

- [ ] **Step 18: Rule 2 — `rule-discount-abuse.ts`**

Test — create `apps/api/src/modules/fraud/rules/rule-discount-abuse.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../transactions/transactions.repository.js', () => ({
  transactionsRepository: { findClosedShiftTransactionSummaries: vi.fn() },
}));

const { transactionsRepository } = await import('../../transactions/transactions.repository.js');
const { discountAbuseRule } = await import('./rule-discount-abuse.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function discountedTxn(id: string, discountType: string) {
  return { id, status: 'completed', discountType, voidedAt: null };
}

describe('discountAbuseRule', () => {
  it('is a branch-scoped rule', () => {
    expect(discountAbuseRule.scope).toBe('branch');
  });

  it('flags a shift with more than 5 discounted completed transactions, of any discount type', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      {
        id: 'shift-1',
        cashierId: 'user-1',
        closedAt: new Date(),
        transactions: [
          discountedTxn('txn-1', 'pwd'),
          discountedTxn('txn-2', 'senior_citizen'),
          discountedTxn('txn-3', 'promotional'),
          discountedTxn('txn-4', 'employee'),
          discountedTxn('txn-5', 'pwd'),
          discountedTxn('txn-6', 'promotional'),
        ],
      },
    ] as never);

    const result = await discountAbuseRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([
      {
        alertType: 'discount_abuse',
        severity: 'medium',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: {
          shift_id: 'shift-1',
          discount_count: 6,
          discount_transaction_ids: ['txn-1', 'txn-2', 'txn-3', 'txn-4', 'txn-5', 'txn-6'],
        },
      },
    ]);
  });

  it('does not flag a shift with exactly 5 discounted transactions (threshold is >5)', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      {
        id: 'shift-1',
        cashierId: 'user-1',
        closedAt: new Date(),
        transactions: Array.from({ length: 5 }, (_, i) => discountedTxn(`txn-${i}`, 'promotional')),
      },
    ] as never);

    const result = await discountAbuseRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
```

Implementation — create `apps/api/src/modules/fraud/rules/rule-discount-abuse.ts`:
```ts
import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { transactionsRepository } from '../../transactions/transactions.repository.js';
import { dayBounds } from './fraud-rule.utils.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12: "Discount abuse — >5 discounted transactions in one shift — Medium". Decision #3: any discountType counts, not just statutory. */
const DISCOUNT_THRESHOLD = 5;

export const discountAbuseRule: FraudRule = {
  scope: 'branch',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    if (!context.branchId) return [];
    const { dayStart, dayEnd } = dayBounds(context.evaluationDate);
    const shifts = await transactionsRepository.findClosedShiftTransactionSummaries(context.branchId, dayStart, dayEnd);

    const results: DetectionResult[] = [];
    for (const shift of shifts) {
      const discountedIds = shift.transactions
        .filter((t) => t.status === 'completed' && t.discountType !== null)
        .map((t) => t.id);
      if (discountedIds.length <= DISCOUNT_THRESHOLD) continue;
      results.push({
        alertType: 'discount_abuse',
        severity: FRAUD_ALERT_SEVERITY.MEDIUM,
        branchId: context.branchId,
        employeeId: shift.cashierId,
        evidence: { shift_id: shift.id, discount_count: discountedIds.length, discount_transaction_ids: discountedIds },
      });
    }
    return results;
  },
};
```

Run, verify fail then pass:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/rules/rule-discount-abuse.test.ts
```

Commit:
```bash
git add apps/api/src/modules/fraud/rules/rule-discount-abuse.ts apps/api/src/modules/fraud/rules/rule-discount-abuse.test.ts
git commit -m "feat(fraud): implement discount-abuse detection rule"
```

- [ ] **Step 19: Rule 7 — `rule-employee-self-discount.ts`** (grouped next to Rule 2 since it reuses the same repository call and shape)

Test — create `apps/api/src/modules/fraud/rules/rule-employee-self-discount.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../transactions/transactions.repository.js', () => ({
  transactionsRepository: { findClosedShiftTransactionSummaries: vi.fn() },
}));

const { transactionsRepository } = await import('../../transactions/transactions.repository.js');
const { employeeSelfDiscountRule } = await import('./rule-employee-self-discount.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function txn(id: string, discountType: string | null) {
  return { id, status: 'completed', discountType, voidedAt: null };
}

describe('employeeSelfDiscountRule', () => {
  it('is a branch-scoped rule', () => {
    expect(employeeSelfDiscountRule.scope).toBe('branch');
  });

  it('flags a shift with more than 2 employee-discount transactions, ignoring other discount types', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      {
        id: 'shift-1',
        cashierId: 'user-1',
        closedAt: new Date(),
        transactions: [txn('txn-1', 'employee'), txn('txn-2', 'employee'), txn('txn-3', 'employee'), txn('txn-4', 'pwd')],
      },
    ] as never);

    const result = await employeeSelfDiscountRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([
      {
        alertType: 'employee_self_discount_frequency',
        severity: 'low',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: { shift_id: 'shift-1', employee_discount_count: 3, employee_discount_transaction_ids: ['txn-1', 'txn-2', 'txn-3'] },
      },
    ]);
  });

  it('does not flag a shift with exactly 2 employee-discount transactions (threshold is >2)', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      { id: 'shift-1', cashierId: 'user-1', closedAt: new Date(), transactions: [txn('txn-1', 'employee'), txn('txn-2', 'employee')] },
    ] as never);

    const result = await employeeSelfDiscountRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
```

Implementation — create `apps/api/src/modules/fraud/rules/rule-employee-self-discount.ts`:
```ts
import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { transactionsRepository } from '../../transactions/transactions.repository.js';
import { dayBounds } from './fraud-rule.utils.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12: "Employee self-discount frequency — Employee discount applied >2× per shift — Low". Task 1 confirmed DISCOUNT_TYPE.EMPLOYEE === 'employee'. */
const EMPLOYEE_DISCOUNT_THRESHOLD = 2;
const EMPLOYEE_DISCOUNT_TYPE = 'employee';

export const employeeSelfDiscountRule: FraudRule = {
  scope: 'branch',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    if (!context.branchId) return [];
    const { dayStart, dayEnd } = dayBounds(context.evaluationDate);
    const shifts = await transactionsRepository.findClosedShiftTransactionSummaries(context.branchId, dayStart, dayEnd);

    const results: DetectionResult[] = [];
    for (const shift of shifts) {
      const employeeDiscountIds = shift.transactions
        .filter((t) => t.status === 'completed' && t.discountType === EMPLOYEE_DISCOUNT_TYPE)
        .map((t) => t.id);
      if (employeeDiscountIds.length <= EMPLOYEE_DISCOUNT_THRESHOLD) continue;
      results.push({
        alertType: 'employee_self_discount_frequency',
        severity: FRAUD_ALERT_SEVERITY.LOW,
        branchId: context.branchId,
        employeeId: shift.cashierId,
        evidence: {
          shift_id: shift.id,
          employee_discount_count: employeeDiscountIds.length,
          employee_discount_transaction_ids: employeeDiscountIds,
        },
      });
    }
    return results;
  },
};
```

Run, verify fail then pass; commit:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/rules/rule-employee-self-discount.test.ts
git add apps/api/src/modules/fraud/rules/rule-employee-self-discount.ts apps/api/src/modules/fraud/rules/rule-employee-self-discount.test.ts
git commit -m "feat(fraud): implement employee-self-discount-frequency detection rule"
```

- [ ] **Step 20: Rule 6 — `rule-end-of-shift-void.ts`**

Test — create `apps/api/src/modules/fraud/rules/rule-end-of-shift-void.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../transactions/transactions.repository.js', () => ({
  transactionsRepository: { findClosedShiftTransactionSummaries: vi.fn() },
}));

const { transactionsRepository } = await import('../../transactions/transactions.repository.js');
const { endOfShiftVoidRule } = await import('./rule-end-of-shift-void.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('endOfShiftVoidRule', () => {
  it('is a branch-scoped rule', () => {
    expect(endOfShiftVoidRule.scope).toBe('branch');
  });

  it('flags a void that happened within the last 10 minutes before shift close', async () => {
    const closedAt = new Date('2026-07-17T22:00:00.000Z');
    const voidedAt = new Date('2026-07-17T21:55:00.000Z'); // 5 minutes before close
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      { id: 'shift-1', cashierId: 'user-1', closedAt, transactions: [{ id: 'txn-1', status: 'voided', discountType: null, voidedAt }] },
    ] as never);

    const result = await endOfShiftVoidRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([
      {
        alertType: 'end_of_shift_void',
        severity: 'low',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: {
          shift_id: 'shift-1',
          transaction_id: 'txn-1',
          voided_at: voidedAt.toISOString(),
          shift_closed_at: closedAt.toISOString(),
        },
      },
    ]);
  });

  it('does not flag a void that happened more than 10 minutes before shift close', async () => {
    const closedAt = new Date('2026-07-17T22:00:00.000Z');
    const voidedAt = new Date('2026-07-17T21:30:00.000Z'); // 30 minutes before close
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      { id: 'shift-1', cashierId: 'user-1', closedAt, transactions: [{ id: 'txn-1', status: 'voided', discountType: null, voidedAt }] },
    ] as never);

    const result = await endOfShiftVoidRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });

  it('skips a shift with no closedAt', async () => {
    vi.mocked(transactionsRepository.findClosedShiftTransactionSummaries).mockResolvedValue([
      { id: 'shift-1', cashierId: 'user-1', closedAt: null, transactions: [{ id: 'txn-1', status: 'voided', discountType: null, voidedAt: new Date() }] },
    ] as never);

    const result = await endOfShiftVoidRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
```

Implementation — create `apps/api/src/modules/fraud/rules/rule-end-of-shift-void.ts`:
```ts
import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { transactionsRepository } from '../../transactions/transactions.repository.js';
import { dayBounds } from './fraud-rule.utils.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12: "End of shift void — Void submitted in the last 10 minutes of a shift — Low". */
const END_OF_SHIFT_WINDOW_MS = 10 * 60 * 1000;

export const endOfShiftVoidRule: FraudRule = {
  scope: 'branch',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    if (!context.branchId) return [];
    const { dayStart, dayEnd } = dayBounds(context.evaluationDate);
    const shifts = await transactionsRepository.findClosedShiftTransactionSummaries(context.branchId, dayStart, dayEnd);

    const results: DetectionResult[] = [];
    for (const shift of shifts) {
      if (!shift.closedAt) continue;
      const closedAtMs = shift.closedAt.getTime();
      for (const txn of shift.transactions) {
        if (txn.status !== 'voided' || !txn.voidedAt) continue;
        const msBeforeClose = closedAtMs - txn.voidedAt.getTime();
        if (msBeforeClose < 0 || msBeforeClose > END_OF_SHIFT_WINDOW_MS) continue;
        results.push({
          alertType: 'end_of_shift_void',
          severity: FRAUD_ALERT_SEVERITY.LOW,
          branchId: context.branchId,
          employeeId: shift.cashierId,
          evidence: {
            shift_id: shift.id,
            transaction_id: txn.id,
            voided_at: txn.voidedAt.toISOString(),
            shift_closed_at: shift.closedAt.toISOString(),
          },
        });
      }
    }
    return results;
  },
};
```

Run, verify fail then pass; commit:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/rules/rule-end-of-shift-void.test.ts
git add apps/api/src/modules/fraud/rules/rule-end-of-shift-void.ts apps/api/src/modules/fraud/rules/rule-end-of-shift-void.test.ts
git commit -m "feat(fraud): implement end-of-shift-void detection rule"
```

- [ ] **Step 21: Rule 3 — `rule-cash-variance-pattern.ts`**

Test — create `apps/api/src/modules/fraud/rules/rule-cash-variance-pattern.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../cash/cash.repository.js', () => ({
  cashRepository: { findCashiersWithClosedShifts: vi.fn(), findLastNClosedShiftsForCashier: vi.fn() },
}));

const { cashRepository } = await import('../../cash/cash.repository.js');
const { cashVariancePatternRule } = await import('./rule-cash-variance-pattern.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function shift(id: string, varianceApproved: boolean | null) {
  return { id, varianceApproved, closedAt: new Date() };
}

describe('cashVariancePatternRule', () => {
  it('is a branch-scoped rule', () => {
    expect(cashVariancePatternRule.scope).toBe('branch');
  });

  it('flags a cashier with variance in more than 30% of their last 10 closed shifts', async () => {
    vi.mocked(cashRepository.findCashiersWithClosedShifts).mockResolvedValue(['user-1']);
    vi.mocked(cashRepository.findLastNClosedShiftsForCashier).mockResolvedValue([
      shift('s1', true), shift('s2', true), shift('s3', true), shift('s4', false),
      shift('s5', null), shift('s6', null), shift('s7', null), shift('s8', null), shift('s9', null), shift('s10', null),
    ] as never);

    const result = await cashVariancePatternRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([
      {
        alertType: 'cash_variance_pattern',
        severity: 'high',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: { variance_count: 4, shifts_checked: 10, ratio: 0.4, shift_ids: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'] },
      },
    ]);
  });

  it('does not flag a cashier with variance in exactly 30% of shifts (threshold is >30%)', async () => {
    vi.mocked(cashRepository.findCashiersWithClosedShifts).mockResolvedValue(['user-1']);
    vi.mocked(cashRepository.findLastNClosedShiftsForCashier).mockResolvedValue([
      shift('s1', true), shift('s2', true), shift('s3', true),
      shift('s4', null), shift('s5', null), shift('s6', null), shift('s7', null), shift('s8', null), shift('s9', null), shift('s10', null),
    ] as never);

    const result = await cashVariancePatternRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });

  it('skips a cashier with fewer than 10 closed shifts in their history', async () => {
    vi.mocked(cashRepository.findCashiersWithClosedShifts).mockResolvedValue(['user-1']);
    vi.mocked(cashRepository.findLastNClosedShiftsForCashier).mockResolvedValue([shift('s1', true), shift('s2', true)] as never);

    const result = await cashVariancePatternRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
```

Implementation — create `apps/api/src/modules/fraud/rules/rule-cash-variance-pattern.ts`:
```ts
import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { cashRepository } from '../../cash/cash.repository.js';
import { dayBounds } from './fraud-rule.utils.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12 / Part 9: "Variance in >30% of last 10 closing counts — High". Decision #6: "variance" = varianceApproved !== null (outside tolerance, required a decision). */
const WINDOW_SIZE = 10;
const RATIO_THRESHOLD = 0.3;

export const cashVariancePatternRule: FraudRule = {
  scope: 'branch',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    if (!context.branchId) return [];
    const { dayStart, dayEnd } = dayBounds(context.evaluationDate);
    const cashierIds = await cashRepository.findCashiersWithClosedShifts(context.branchId, dayStart, dayEnd);

    const results: DetectionResult[] = [];
    for (const cashierId of cashierIds) {
      const lastShifts = await cashRepository.findLastNClosedShiftsForCashier(cashierId, context.branchId, WINDOW_SIZE);
      if (lastShifts.length < WINDOW_SIZE) continue;

      const varianceCount = lastShifts.filter((shift) => shift.varianceApproved !== null).length;
      const ratio = varianceCount / lastShifts.length;
      if (ratio <= RATIO_THRESHOLD) continue;

      results.push({
        alertType: 'cash_variance_pattern',
        severity: FRAUD_ALERT_SEVERITY.HIGH,
        branchId: context.branchId,
        employeeId: cashierId,
        evidence: {
          variance_count: varianceCount,
          shifts_checked: lastShifts.length,
          ratio: Number(ratio.toFixed(2)),
          shift_ids: lastShifts.map((shift) => shift.id),
        },
      });
    }
    return results;
  },
};
```

Run, verify fail then pass; commit:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/rules/rule-cash-variance-pattern.test.ts
git add apps/api/src/modules/fraud/rules/rule-cash-variance-pattern.ts apps/api/src/modules/fraud/rules/rule-cash-variance-pattern.test.ts
git commit -m "feat(fraud): implement cash-variance-pattern detection rule"
```

- [ ] **Step 22: Rule 4 — `rule-gcash-volume-anomaly.ts`**

Test — create `apps/api/src/modules/fraud/rules/rule-gcash-volume-anomaly.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../transactions/transactions.repository.js', () => ({
  transactionsRepository: { findGcashCountsByCashierForDate: vi.fn(), countGcashTransactionsForBranchWindow: vi.fn() },
}));

const { transactionsRepository } = await import('../../transactions/transactions.repository.js');
const { gcashVolumeAnomalyRule } = await import('./rule-gcash-volume-anomaly.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gcashVolumeAnomalyRule', () => {
  it('is a branch-scoped rule', () => {
    expect(gcashVolumeAnomalyRule.scope).toBe('branch');
  });

  it('flags a cashier whose GCash count today is more than 50% above the 30-day branch daily average', async () => {
    // 300 GCash transactions over 30 days = average 10/day; 1.5x threshold = 15; 16 > 15
    vi.mocked(transactionsRepository.countGcashTransactionsForBranchWindow).mockResolvedValue(300);
    vi.mocked(transactionsRepository.findGcashCountsByCashierForDate).mockResolvedValue([{ cashierId: 'user-1', gcashCount: 16 }]);

    const result = await gcashVolumeAnomalyRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([
      {
        alertType: 'gcash_volume_anomaly',
        severity: 'medium',
        branchId: 'branch-1',
        employeeId: 'user-1',
        evidence: { gcash_count_today: 16, branch_daily_average: 10, threshold: 15, window_days: 30 },
      },
    ]);
  });

  it('does not flag a cashier at or below the threshold', async () => {
    vi.mocked(transactionsRepository.countGcashTransactionsForBranchWindow).mockResolvedValue(300);
    vi.mocked(transactionsRepository.findGcashCountsByCashierForDate).mockResolvedValue([{ cashierId: 'user-1', gcashCount: 15 }]);

    const result = await gcashVolumeAnomalyRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });

  it('skips the check entirely when the branch has no GCash history (average is 0)', async () => {
    vi.mocked(transactionsRepository.countGcashTransactionsForBranchWindow).mockResolvedValue(0);
    vi.mocked(transactionsRepository.findGcashCountsByCashierForDate).mockResolvedValue([{ cashierId: 'user-1', gcashCount: 5 }]);

    const result = await gcashVolumeAnomalyRule.evaluate({ branchId: 'branch-1', evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
```

Implementation — create `apps/api/src/modules/fraud/rules/rule-gcash-volume-anomaly.ts`:
```ts
import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { transactionsRepository } from '../../transactions/transactions.repository.js';
import { dayBounds } from './fraud-rule.utils.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12: "GCash volume anomaly — significantly above branch average — Medium". Decision #1: >50% above the 30-day branch daily average, by transaction count. */
const ANOMALY_MULTIPLIER = 1.5;
const TRAILING_WINDOW_DAYS = 30;

export const gcashVolumeAnomalyRule: FraudRule = {
  scope: 'branch',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    if (!context.branchId) return [];
    const { dayStart, dayEnd } = dayBounds(context.evaluationDate);
    const windowStart = new Date(dayEnd.getTime() - TRAILING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [todayCounts, windowTotal] = await Promise.all([
      transactionsRepository.findGcashCountsByCashierForDate(context.branchId, dayStart, dayEnd),
      transactionsRepository.countGcashTransactionsForBranchWindow(context.branchId, windowStart, dayEnd),
    ]);

    const branchDailyAverage = windowTotal / TRAILING_WINDOW_DAYS;
    // A branch with no GCash history yet would trivially fail "50% above zero" for its very first transaction — skip rather than false-positive on sparse data.
    if (branchDailyAverage <= 0) return [];

    const threshold = branchDailyAverage * ANOMALY_MULTIPLIER;
    const results: DetectionResult[] = [];
    for (const row of todayCounts) {
      if (row.gcashCount <= threshold) continue;
      results.push({
        alertType: 'gcash_volume_anomaly',
        severity: FRAUD_ALERT_SEVERITY.MEDIUM,
        branchId: context.branchId,
        employeeId: row.cashierId,
        evidence: {
          gcash_count_today: row.gcashCount,
          branch_daily_average: Number(branchDailyAverage.toFixed(2)),
          threshold: Number(threshold.toFixed(2)),
          window_days: TRAILING_WINDOW_DAYS,
        },
      });
    }
    return results;
  },
};
```

Run, verify fail then pass; commit:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/rules/rule-gcash-volume-anomaly.test.ts
git add apps/api/src/modules/fraud/rules/rule-gcash-volume-anomaly.ts apps/api/src/modules/fraud/rules/rule-gcash-volume-anomaly.test.ts
git commit -m "feat(fraud): implement gcash-volume-anomaly detection rule"
```

- [ ] **Step 23: Rule 5 — `rule-discount-id-reuse.ts`** (the one `'global'`-scope rule)

Test — create `apps/api/src/modules/fraud/rules/rule-discount-id-reuse.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../transactions/transactions.repository.js', () => ({
  transactionsRepository: { findStatutoryDiscountsInWindow: vi.fn() },
}));

const { transactionsRepository } = await import('../../transactions/transactions.repository.js');
const { discountIdReuseRule } = await import('./rule-discount-id-reuse.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function discountTxn(id: string, branchId: string, hash: string) {
  return { id, branchId, cashierId: 'user-1', discountCustomerIdHash: hash, createdAt: new Date() };
}

describe('discountIdReuseRule', () => {
  it('is a global-scope rule (not per-branch — Corrections #4)', () => {
    expect(discountIdReuseRule.scope).toBe('global');
  });

  it('flags a customer ID hash used more than 3 times in the window, even across different branches', async () => {
    vi.mocked(transactionsRepository.findStatutoryDiscountsInWindow).mockResolvedValue([
      discountTxn('txn-1', 'branch-1', 'hash-a'),
      discountTxn('txn-2', 'branch-2', 'hash-a'),
      discountTxn('txn-3', 'branch-1', 'hash-a'),
      discountTxn('txn-4', 'branch-3', 'hash-a'),
      discountTxn('txn-5', 'branch-1', 'hash-b'),
    ] as never);

    const result = await discountIdReuseRule.evaluate({ branchId: null, evaluationDate: new Date() });

    expect(result).toEqual([
      {
        alertType: 'discount_id_reuse',
        severity: 'high',
        branchId: null,
        employeeId: null,
        evidence: {
          customer_id_hash: 'hash-a',
          occurrence_count: 4,
          window_days: 30,
          transaction_ids: ['txn-1', 'txn-2', 'txn-3', 'txn-4'],
          branch_ids: ['branch-1', 'branch-2', 'branch-3'],
        },
      },
    ]);
  });

  it('does not flag a hash used exactly 3 times (threshold is >3)', async () => {
    vi.mocked(transactionsRepository.findStatutoryDiscountsInWindow).mockResolvedValue([
      discountTxn('txn-1', 'branch-1', 'hash-a'),
      discountTxn('txn-2', 'branch-1', 'hash-a'),
      discountTxn('txn-3', 'branch-1', 'hash-a'),
    ] as never);

    const result = await discountIdReuseRule.evaluate({ branchId: null, evaluationDate: new Date() });

    expect(result).toEqual([]);
  });
});
```

Implementation — create `apps/api/src/modules/fraud/rules/rule-discount-id-reuse.ts`:
```ts
import { FRAUD_ALERT_SEVERITY } from '@potato-corner/shared';
import { transactionsRepository } from '../../transactions/transactions.repository.js';
import type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';

/** Architecture doc Part 12: "Discount ID reuse — same customer ID for statutory discount >3× in 30 days — High". Corrections #4: global-scope, can span branches. */
const WINDOW_DAYS = 30;
const REUSE_THRESHOLD = 3;

interface StatutoryDiscountRow {
  id: string;
  branchId: string;
  discountCustomerIdHash: string | null;
}

export const discountIdReuseRule: FraudRule = {
  scope: 'global',
  async evaluate(context: RuleContext): Promise<DetectionResult[]> {
    const windowEnd = context.evaluationDate;
    const windowStart = new Date(windowEnd.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await transactionsRepository.findStatutoryDiscountsInWindow(windowStart, windowEnd);

    const byHash = new Map<string, StatutoryDiscountRow[]>();
    for (const row of rows) {
      if (!row.discountCustomerIdHash) continue;
      const existing = byHash.get(row.discountCustomerIdHash) ?? [];
      existing.push(row);
      byHash.set(row.discountCustomerIdHash, existing);
    }

    const results: DetectionResult[] = [];
    for (const [hash, transactions] of byHash) {
      if (transactions.length <= REUSE_THRESHOLD) continue;
      results.push({
        alertType: 'discount_id_reuse',
        severity: FRAUD_ALERT_SEVERITY.HIGH,
        branchId: null,
        employeeId: null,
        evidence: {
          customer_id_hash: hash,
          occurrence_count: transactions.length,
          window_days: WINDOW_DAYS,
          transaction_ids: transactions.map((t) => t.id),
          branch_ids: [...new Set(transactions.map((t) => t.branchId))],
        },
      });
    }
    return results;
  },
};
```

Run, verify fail then pass; commit:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/rules/rule-discount-id-reuse.test.ts
git add apps/api/src/modules/fraud/rules/rule-discount-id-reuse.ts apps/api/src/modules/fraud/rules/rule-discount-id-reuse.test.ts
git commit -m "feat(fraud): implement discount-id-reuse detection rule (global scope)"
```

- [ ] **Step 24: `rules/index.ts`**

Create `apps/api/src/modules/fraud/rules/index.ts`:
```ts
import { excessiveVoidsRule } from './rule-excessive-voids.js';
import { discountAbuseRule } from './rule-discount-abuse.js';
import { cashVariancePatternRule } from './rule-cash-variance-pattern.js';
import { gcashVolumeAnomalyRule } from './rule-gcash-volume-anomaly.js';
import { discountIdReuseRule } from './rule-discount-id-reuse.js';
import { endOfShiftVoidRule } from './rule-end-of-shift-void.js';
import { employeeSelfDiscountRule } from './rule-employee-self-discount.js';
import type { FraudRule } from './fraud-rule.types.js';

/** All 7 Architecture doc Part 12 detection rules, in the same order as the spec's table. */
export const FRAUD_RULES: FraudRule[] = [
  excessiveVoidsRule,
  discountAbuseRule,
  cashVariancePatternRule,
  gcashVolumeAnomalyRule,
  discountIdReuseRule,
  endOfShiftVoidRule,
  employeeSelfDiscountRule,
];

export type { DetectionResult, FraudRule, RuleContext } from './fraud-rule.types.js';
```

- [ ] **Step 25: Full-suite check and typecheck**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/rules
pnpm --filter @potato-corner/api run type-check
```
Expected: all rule tests pass (7 rules × 2–4 tests each = ~20 tests), typecheck clean.

- [ ] **Step 26: Commit**

```bash
git add apps/api/src/modules/fraud/rules/index.ts
git commit -m "feat(fraud): export FRAUD_RULES array of all 7 detection rules"
```

**Deviation protocol:** If any rule's exact evidence field names conflict with what Task 6's `detection.service.ts` expects (Task 6 is written after this task in this plan, so it already matches) — if executing tasks out of order, treat the `DetectionResult.evidence` shapes shown here as the source of truth; do not rename fields in Task 6 without updating the corresponding rule's test fixtures to match.

---

### Task 6: Detection engine service

**Dependencies:** Task 4 (repository methods), Task 5 (`FRAUD_RULES`, `DetectionResult`, `FraudRule` types).

**Files:**
- Create: `apps/api/src/modules/fraud/detection.service.ts`
- Create: `apps/api/src/modules/fraud/detection.service.test.ts`
- Modify: `packages/shared/src/constants/events.ts` (add `FRAUD_SCAN_FAILED` — used by Task 7, added here since it's a one-line shared-package change with no other natural home)

**Interfaces:**
- Consumes: `FRAUD_RULES` (Task 5), `fraudRepository.{createAlert,findRecentOpenAlert,findOpenAlertsByType,findActiveBranchIds}` (Task 4), `notifySuperAdmin` (`../../lib/notify.js`), `SOCKET_EVENTS.FRAUD_ALERT_CREATED` (`@potato-corner/shared`).
- Produces: `runDetection(evaluationDate: Date, branchIds?: string[]): Promise<RunResult>`, where `RunResult = { branchesEvaluated: number; rulesEvaluated: number; alertsCreated: number; alertsSkippedDupe: number }`. Task 7's `fraud.queue.ts` worker calls this for both `nightly_scan` and `manual_scan` jobs.

- [ ] **Step 1: Add `FRAUD_SCAN_FAILED` to shared events (needed by Task 7, placed here for a single shared-package touch)**

In `packages/shared/src/constants/events.ts`, find:
```ts
  FRAUD_ALERT_ESCALATED: 'fraud:alert_escalated',
```
Replace with:
```ts
  FRAUD_ALERT_ESCALATED: 'fraud:alert_escalated',
  // Phase 17 — emitted by fraud.queue.ts's failed handler after the final
  // retry attempt of a nightly_scan or manual_scan job is exhausted.
  FRAUD_SCAN_FAILED: 'fraud:scan_failed',
```

- [ ] **Step 2: Write the failing tests**

Create `apps/api/src/modules/fraud/detection.service.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./fraud.repository.js', () => ({
  fraudRepository: {
    findActiveBranchIds: vi.fn(),
    createAlert: vi.fn(),
    findRecentOpenAlert: vi.fn(),
    findOpenAlertsByType: vi.fn(),
  },
}));

vi.mock('../../lib/notify.js', () => ({
  notifySuperAdmin: vi.fn(),
}));

vi.mock('./rules/index.js', () => ({
  FRAUD_RULES: [],
}));

const { fraudRepository } = await import('./fraud.repository.js');
const { notifySuperAdmin } = await import('../../lib/notify.js');
const rulesModule = await import('./rules/index.js');
const { runDetection } = await import('./detection.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  (rulesModule.FRAUD_RULES as unknown[]).length = 0;
});

function branchRule(alertType: string, results: unknown[]) {
  return { scope: 'branch' as const, evaluate: vi.fn().mockResolvedValue(results) };
}

function globalRule(alertType: string, results: unknown[]) {
  return { scope: 'global' as const, evaluate: vi.fn().mockResolvedValue(results) };
}

describe('runDetection — branch-scoped rules', () => {
  it('calls a branch-scoped rule once per active branch', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }]);
    const rule = branchRule('excessive_voids', []);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    await runDetection(new Date('2026-07-17T15:00:00.000Z'));

    expect(rule.evaluate).toHaveBeenCalledTimes(2);
    expect(rule.evaluate).toHaveBeenCalledWith({ branchId: 'branch-1', evaluationDate: expect.any(Date) });
    expect(rule.evaluate).toHaveBeenCalledWith({ branchId: 'branch-2', evaluationDate: expect.any(Date) });
  });

  it('uses the caller-provided branchIds instead of querying active branches when given', async () => {
    const rule = branchRule('excessive_voids', []);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    await runDetection(new Date(), ['branch-9']);

    expect(fraudRepository.findActiveBranchIds).not.toHaveBeenCalled();
    expect(rule.evaluate).toHaveBeenCalledWith({ branchId: 'branch-9', evaluationDate: expect.any(Date) });
  });
});

describe('runDetection — global-scoped rules', () => {
  it('calls a global-scoped rule exactly once with branchId: null, regardless of branch count', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }]);
    const rule = globalRule('discount_id_reuse', []);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    await runDetection(new Date());

    expect(rule.evaluate).toHaveBeenCalledTimes(1);
    expect(rule.evaluate).toHaveBeenCalledWith({ branchId: null, evaluationDate: expect.any(Date) });
  });
});

describe('runDetection — alert creation and dedup (standard key)', () => {
  it('creates an alert and emits FRAUD_ALERT_CREATED when no open/investigating duplicate exists', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([{ id: 'branch-1' }]);
    vi.mocked(fraudRepository.findRecentOpenAlert).mockResolvedValue(null);
    vi.mocked(fraudRepository.createAlert).mockResolvedValue({
      id: 'alert-1', alertType: 'excessive_voids', severity: 'medium', branchId: 'branch-1', employeeId: 'user-1', status: 'open',
      createdAt: new Date('2026-07-17T15:00:00.000Z'),
    } as never);
    const detectionResult = {
      alertType: 'excessive_voids', severity: 'medium', branchId: 'branch-1', employeeId: 'user-1',
      evidence: { shift_id: 'shift-1', void_count: 4 },
    };
    const rule = branchRule('excessive_voids', [detectionResult]);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    const result = await runDetection(new Date());

    expect(fraudRepository.findRecentOpenAlert).toHaveBeenCalledWith('branch-1', 'user-1', 'excessive_voids');
    expect(fraudRepository.createAlert).toHaveBeenCalledWith(detectionResult);
    expect(notifySuperAdmin).toHaveBeenCalledWith('fraud:alert_created', expect.objectContaining({ id: 'alert-1', alert_type: 'excessive_voids' }));
    expect(result.alertsCreated).toBe(1);
    expect(result.alertsSkippedDupe).toBe(0);
  });

  it('skips creating an alert when an open/investigating duplicate already exists for the standard key', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([{ id: 'branch-1' }]);
    vi.mocked(fraudRepository.findRecentOpenAlert).mockResolvedValue({ id: 'alert-existing' } as never);
    const rule = branchRule('excessive_voids', [
      { alertType: 'excessive_voids', severity: 'medium', branchId: 'branch-1', employeeId: 'user-1', evidence: {} },
    ]);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    const result = await runDetection(new Date());

    expect(fraudRepository.createAlert).not.toHaveBeenCalled();
    expect(notifySuperAdmin).not.toHaveBeenCalled();
    expect(result.alertsCreated).toBe(0);
    expect(result.alertsSkippedDupe).toBe(1);
  });
});

describe('runDetection — alert creation and dedup (discount_id_reuse special-case key)', () => {
  it('creates an alert when no open alert has a matching customer_id_hash', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([]);
    vi.mocked(fraudRepository.findOpenAlertsByType).mockResolvedValue([{ id: 'alert-other', evidence: { customer_id_hash: 'hash-b' } }]);
    vi.mocked(fraudRepository.createAlert).mockResolvedValue({
      id: 'alert-2', alertType: 'discount_id_reuse', severity: 'high', branchId: null, employeeId: null, status: 'open',
      createdAt: new Date(),
    } as never);
    const detectionResult = {
      alertType: 'discount_id_reuse', severity: 'high', branchId: null, employeeId: null,
      evidence: { customer_id_hash: 'hash-a', occurrence_count: 4 },
    };
    const rule = globalRule('discount_id_reuse', [detectionResult]);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    const result = await runDetection(new Date());

    expect(fraudRepository.findOpenAlertsByType).toHaveBeenCalledWith('discount_id_reuse');
    expect(fraudRepository.findRecentOpenAlert).not.toHaveBeenCalled();
    expect(fraudRepository.createAlert).toHaveBeenCalledWith(detectionResult);
    expect(result.alertsCreated).toBe(1);
  });

  it('skips creating an alert when an open alert already has a matching customer_id_hash', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([]);
    vi.mocked(fraudRepository.findOpenAlertsByType).mockResolvedValue([{ id: 'alert-existing', evidence: { customer_id_hash: 'hash-a' } }]);
    const rule = globalRule('discount_id_reuse', [
      { alertType: 'discount_id_reuse', severity: 'high', branchId: null, employeeId: null, evidence: { customer_id_hash: 'hash-a' } },
    ]);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    const result = await runDetection(new Date());

    expect(fraudRepository.createAlert).not.toHaveBeenCalled();
    expect(result.alertsSkippedDupe).toBe(1);
  });
});

describe('runDetection — summary', () => {
  it('returns branchesEvaluated, rulesEvaluated, alertsCreated, alertsSkippedDupe', async () => {
    vi.mocked(fraudRepository.findActiveBranchIds).mockResolvedValue([{ id: 'branch-1' }, { id: 'branch-2' }]);
    vi.mocked(fraudRepository.findRecentOpenAlert).mockResolvedValue(null);
    vi.mocked(fraudRepository.createAlert).mockResolvedValue({ id: 'alert-1', createdAt: new Date() } as never);
    const rule = branchRule('excessive_voids', [{ alertType: 'excessive_voids', severity: 'medium', branchId: null, employeeId: null, evidence: {} }]);
    (rulesModule.FRAUD_RULES as unknown[]).push(rule);

    const result = await runDetection(new Date());

    expect(result.branchesEvaluated).toBe(2);
    expect(result.rulesEvaluated).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/detection.service.test.ts
```
Expected: FAIL — cannot find module `./detection.service.js`.

- [ ] **Step 4: Implement `detection.service.ts`**

```ts
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { fraudRepository } from './fraud.repository.js';
import { FRAUD_RULES } from './rules/index.js';
import type { DetectionResult } from './rules/fraud-rule.types.js';
import { notifySuperAdmin } from '../../lib/notify.js';

export interface RunResult {
  branchesEvaluated: number;
  rulesEvaluated: number;
  alertsCreated: number;
  alertsSkippedDupe: number;
}

function extractCustomerIdHash(evidence: unknown): string | null {
  if (evidence && typeof evidence === 'object' && 'customer_id_hash' in evidence) {
    const value = (evidence as { customer_id_hash: unknown }).customer_id_hash;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/**
 * discount_id_reuse has no natural employeeId/single branchId to dedup on
 * (Corrections #4) — every other rule uses the standard (branchId,
 * employeeId, alertType) key from the locked decisions.
 */
async function isDuplicate(result: DetectionResult): Promise<boolean> {
  if (result.alertType === 'discount_id_reuse') {
    const hash = extractCustomerIdHash(result.evidence);
    if (!hash) return false;
    const openAlerts = await fraudRepository.findOpenAlertsByType('discount_id_reuse');
    return openAlerts.some((alert) => extractCustomerIdHash(alert.evidence) === hash);
  }
  const existing = await fraudRepository.findRecentOpenAlert(result.branchId, result.employeeId, result.alertType);
  return existing !== null;
}

async function processResult(result: DetectionResult): Promise<boolean> {
  if (await isDuplicate(result)) return false;

  const alert = await fraudRepository.createAlert(result);
  notifySuperAdmin(SOCKET_EVENTS.FRAUD_ALERT_CREATED, {
    id: alert.id,
    alert_type: alert.alertType,
    severity: alert.severity,
    branch_id: alert.branchId,
    employee_id: alert.employeeId,
    status: alert.status,
    created_at: alert.createdAt.toISOString(),
  });
  return true;
}

/**
 * Runs every rule in FRAUD_RULES: branch-scoped rules once per active
 * branch (or the caller-provided branchIds, for the manual-trigger
 * endpoint's testing/recovery use case), global-scoped rules exactly once.
 * Owns dedup and FRAUD_ALERT_CREATED broadcast — rule modules never write
 * or emit anything themselves.
 */
export async function runDetection(evaluationDate: Date, branchIds?: string[]): Promise<RunResult> {
  const branches = branchIds ?? (await fraudRepository.findActiveBranchIds()).map((branch) => branch.id);

  let alertsCreated = 0;
  let alertsSkippedDupe = 0;

  for (const rule of FRAUD_RULES) {
    const targets = rule.scope === 'global' ? [null] : branches;
    for (const branchId of targets) {
      const results = await rule.evaluate({ branchId, evaluationDate });
      for (const result of results) {
        const created = await processResult(result);
        if (created) alertsCreated += 1;
        else alertsSkippedDupe += 1;
      }
    }
  }

  return { branchesEvaluated: branches.length, rulesEvaluated: FRAUD_RULES.length, alertsCreated, alertsSkippedDupe };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/detection.service.test.ts
```
Expected: PASS, 8 tests.

- [ ] **Step 6: Typecheck the shared package first (events.ts changed), then the API**

Run:
```bash
pnpm --filter @potato-corner/shared run build
pnpm --filter @potato-corner/api run type-check
```
Expected: both pass. (`@potato-corner/shared` must be rebuilt before the API's typecheck picks up the new `FRAUD_SCAN_FAILED` export, since the API imports the shared package's compiled `dist` output per its `workspace:*` dependency.)

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/constants/events.ts apps/api/src/modules/fraud/detection.service.ts apps/api/src/modules/fraud/detection.service.test.ts
git commit -m "feat(fraud): add detection engine orchestrating all 7 rules with dedup and broadcast"
```

**Deviation protocol:** If `notifySuperAdmin`'s existing call sites elsewhere in the codebase pass a differently-shaped payload for other `FRAUD_ALERT_*` events (there are none today — Corrections #7/Section E of the audit confirmed `FRAUD_ALERT_CREATED` has never been emitted before this task), do not attempt to match a nonexistent prior convention; the snake_case shape given in Step 4 is the first and canonical one.

---

### Task 7: BullMQ scheduler — rewrite `fraud.queue.ts`

**Dependencies:** Task 6 (`runDetection`).

**Files:**
- Modify: `apps/api/src/queues/fraud.queue.ts` (full rewrite of the stub)
- Create: `apps/api/src/queues/fraud.queue.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `runDetection` (Task 6), `createWorkerConnection`/`redis` (`../lib/redis.js`), `notifySuperAdmin` (`../lib/notify.js`), `SOCKET_EVENTS.FRAUD_SCAN_FAILED` (Task 6).
- Produces: `fraudQueue: Queue`, `scheduleNightlyFraudScan(): Promise<Job>`, `enqueueManualFraudScan(data: ManualScanJobData): Promise<Job>`, `fraudWorker: Worker`. Task 8's `fraud.service.ts` calls `enqueueManualFraudScan`; `server.ts` calls `scheduleNightlyFraudScan` once at boot.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/queues/fraud.queue.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const addMock = vi.fn();
const onMock = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: addMock })),
  Worker: vi.fn().mockImplementation((_name: string, processor: (job: Job) => Promise<void>) => ({
    on: onMock,
    __processor: processor,
  })),
}));

vi.mock('../lib/redis.js', () => ({
  redis: {},
  createWorkerConnection: vi.fn().mockReturnValue({ on: vi.fn() }),
}));

vi.mock('../modules/fraud/detection.service.js', () => ({
  runDetection: vi.fn(),
}));

vi.mock('../lib/notify.js', () => ({
  notifySuperAdmin: vi.fn(),
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

const { runDetection } = await import('../modules/fraud/detection.service.js');
const { notifySuperAdmin } = await import('../lib/notify.js');
const Sentry = await import('@sentry/node');
const { fraudQueue, fraudWorker, scheduleNightlyFraudScan, enqueueManualFraudScan } = await import('./fraud.queue.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('scheduleNightlyFraudScan', () => {
  it('registers a repeatable nightly_scan job at 23:00 Asia/Manila with a fixed jobId', async () => {
    await scheduleNightlyFraudScan();

    expect(addMock).toHaveBeenCalledWith(
      'nightly_scan',
      {},
      {
        repeat: { pattern: '0 23 * * *', tz: 'Asia/Manila' },
        jobId: 'fraud-nightly-scan',
        attempts: 3,
        backoff: { type: 'custom' },
      },
    );
  });
});

describe('enqueueManualFraudScan', () => {
  it('enqueues a manual_scan job with the given evaluationDate and requestedBy', async () => {
    await enqueueManualFraudScan({ evaluationDate: '2026-07-17T00:00:00.000Z', requestedBy: 'admin-1' });

    expect(addMock).toHaveBeenCalledWith(
      'manual_scan',
      { evaluationDate: '2026-07-17T00:00:00.000Z', requestedBy: 'admin-1' },
      { attempts: 3, backoff: { type: 'custom' } },
    );
  });
});

describe('fraudWorker processor', () => {
  it('calls runDetection for a nightly_scan job', async () => {
    vi.mocked(runDetection).mockResolvedValue({ branchesEvaluated: 3, rulesEvaluated: 7, alertsCreated: 1, alertsSkippedDupe: 0 });
    const processor = (fraudWorker as unknown as { __processor: (job: Job) => Promise<void> }).__processor;

    await processor({ name: 'nightly_scan', data: {} } as Job);

    expect(runDetection).toHaveBeenCalledWith(expect.any(Date));
  });

  it('calls runDetection with the job-provided evaluationDate for a manual_scan job', async () => {
    vi.mocked(runDetection).mockResolvedValue({ branchesEvaluated: 1, rulesEvaluated: 7, alertsCreated: 0, alertsSkippedDupe: 0 });
    const processor = (fraudWorker as unknown as { __processor: (job: Job) => Promise<void> }).__processor;

    await processor({ name: 'manual_scan', data: { evaluationDate: '2026-07-17T00:00:00.000Z', requestedBy: 'admin-1' } } as Job);

    expect(runDetection).toHaveBeenCalledWith(new Date('2026-07-17T00:00:00.000Z'));
  });
});

describe('fraudWorker failed handler', () => {
  it('registers an "failed" listener on construction', () => {
    expect(onMock).toHaveBeenCalledWith('failed', expect.any(Function));
  });

  it('reports to Sentry and notifies Super Admin only after the final attempt', () => {
    const failedHandler = onMock.mock.calls.find((call) => call[0] === 'failed')?.[1] as (job: Job | undefined, error: Error) => void;
    const job = { name: 'nightly_scan', attemptsMade: 3, opts: { attempts: 3 } } as unknown as Job;

    failedHandler(job, new Error('Redis unreachable'));

    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    expect(notifySuperAdmin).toHaveBeenCalledWith('fraud:scan_failed', {
      job_name: 'nightly_scan',
      error: 'Redis unreachable',
      attempts: 3,
    });
  });

  it('does nothing before the final attempt', () => {
    const failedHandler = onMock.mock.calls.find((call) => call[0] === 'failed')?.[1] as (job: Job | undefined, error: Error) => void;
    const job = { name: 'nightly_scan', attemptsMade: 1, opts: { attempts: 3 } } as unknown as Job;

    failedHandler(job, new Error('transient'));

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(notifySuperAdmin).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/queues/fraud.queue.test.ts
```
Expected: FAIL — `scheduleNightlyFraudScan`/`enqueueManualFraudScan` not exported; `fraudWorker.__processor` is `undefined` since the real `Worker` mock hasn't been given a processor to expose yet at this point (only relevant once the implementation exists — this step just confirms the file's current stub doesn't satisfy the new tests).

- [ ] **Step 3: Rewrite `fraud.queue.ts`**

Replace the entire contents of `apps/api/src/queues/fraud.queue.ts`:
```ts
import { Queue, Worker, type Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { redis, createWorkerConnection } from '../lib/redis.js';
import { notifySuperAdmin } from '../lib/notify.js';
import { runDetection } from '../modules/fraud/detection.service.js';

/** Architecture doc §3.6 retry policy, same 10s/60s/300s schedule as inventory.queue.ts and report.queue.ts. */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

/**
 * 23:00 Asia/Manila — deliberately before the Phase 18 EOD summary's 23:59
 * slot (Architecture doc Part 13), so "open fraud alerts created that day"
 * has this run's output available. jobId is fixed so BullMQ dedupes the
 * repeatable registration itself; calling scheduleNightlyFraudScan() on
 * every process boot is idempotent, not a duplicate schedule.
 */
const NIGHTLY_SCAN_JOB_ID = 'fraud-nightly-scan';
const NIGHTLY_CRON_PATTERN = '0 23 * * *';
const NIGHTLY_TIMEZONE = 'Asia/Manila';

function retryDelayMs(attemptsMade: number): number {
  return RETRY_DELAYS_MS[attemptsMade - 1] ?? 300_000;
}

export interface ManualScanJobData {
  evaluationDate: string;
  requestedBy: string;
}

export const fraudQueue = new Queue('fraud', { connection: redis });

/** Registers the codebase's first repeatable BullMQ job. See Corrections #2 — there is no prior in-repo pattern for this. */
export function scheduleNightlyFraudScan(): Promise<Job> {
  return fraudQueue.add(
    'nightly_scan',
    {},
    {
      repeat: { pattern: NIGHTLY_CRON_PATTERN, tz: NIGHTLY_TIMEZONE },
      jobId: NIGHTLY_SCAN_JOB_ID,
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'custom' },
    },
  );
}

/** Enqueued by fraudService.triggerManualScan (Task 8's Super-Admin-only POST /api/fraud/run). */
export function enqueueManualFraudScan(data: ManualScanJobData): Promise<Job> {
  return fraudQueue.add('manual_scan', data, { attempts: MAX_ATTEMPTS, backoff: { type: 'custom' } });
}

export const fraudWorker = new Worker(
  'fraud',
  async (job: Job) => {
    if (job.name === 'nightly_scan') {
      const result = await runDetection(new Date());
      console.log(`Nightly fraud scan complete: ${JSON.stringify(result)}`);
      return;
    }
    if (job.name === 'manual_scan') {
      const { evaluationDate } = job.data as ManualScanJobData;
      const result = await runDetection(new Date(evaluationDate));
      console.log(`Manual fraud scan complete: ${JSON.stringify(result)}`);
      return;
    }
  },
  { connection: createWorkerConnection(), settings: { backoffStrategy: retryDelayMs } },
);

/** After the final retry attempt, report to Sentry and notify Super Admins — mirrors inventoryWorker.on('failed', ...). */
fraudWorker.on('failed', (job, error) => {
  if (!job) return;
  if (job.attemptsMade < (job.opts.attempts ?? MAX_ATTEMPTS)) return;

  Sentry.captureException(error);
  console.error(`Fraud detection job "${job.name}" permanently failed after ${job.attemptsMade} attempts:`, error.message);
  notifySuperAdmin(SOCKET_EVENTS.FRAUD_SCAN_FAILED, {
    job_name: job.name,
    error: error.message,
    attempts: job.attemptsMade,
  });
});
```

- [ ] **Step 4: Run it to verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/queues/fraud.queue.test.ts
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire the nightly schedule into `server.ts`'s boot sequence**

In `apps/api/src/server.ts`, add the import:
```ts
import { redis } from './lib/redis.js';
import { scheduleNightlyFraudScan } from './queues/fraud.queue.js';
```
Then, inside `async function start(): Promise<void> { ... }`, after the `checkRedisConnection()` block and before `const httpServer = createServer(app);`, add:
```ts
  if (redisOk) {
    try {
      await scheduleNightlyFraudScan();
      console.log('Nightly fraud detection scan scheduled (23:00 Asia/Manila).');
    } catch (error) {
      console.error('Failed to register the nightly fraud detection scan:', error);
      Sentry.captureException(error);
    }
  }

```
So the full `start()` function reads (for reference — only the block above is new):
```ts
async function start(): Promise<void> {
  const redisOk = await checkRedisConnection();
  if (redisOk) {
    console.log('Redis connection verified.');
  } else {
    console.error('Redis is unreachable at startup — continuing, but sessions/rate-limiting/queues will not work.');
  }

  if (redisOk) {
    try {
      await scheduleNightlyFraudScan();
      console.log('Nightly fraud detection scan scheduled (23:00 Asia/Manila).');
    } catch (error) {
      console.error('Failed to register the nightly fraud detection scan:', error);
      Sentry.captureException(error);
    }
  }

  const httpServer = createServer(app);
  createSocketServer(httpServer);

  httpServer.listen(config.port, () => {
    console.log(`API listening on http://localhost:${config.port} [env: ${config.nodeEnv}]`);
  });
}
```
Guarding on `redisOk` avoids the schedule-registration call hanging indefinitely against an unreachable Redis the same way `checkRedisConnection` itself already guards startup.

- [ ] **Step 6: Typecheck**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
```
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/queues/fraud.queue.ts apps/api/src/queues/fraud.queue.test.ts apps/api/src/server.ts
git commit -m "feat(fraud): implement nightly BullMQ scheduler and manual-scan job type"
```

**Deviation protocol:** If `server.ts` has changed since Task 1's Step 3 confirmation (e.g. it now does import other queue files), read the current file in full before editing — insert the `scheduleNightlyFraudScan()` call in the equivalent place in the (changed) `start()` function rather than assuming the exact line numbers shown above still apply.

---

### Task 8: Manual trigger endpoint

**Dependencies:** Task 7 (`enqueueManualFraudScan`).

**Files:**
- Modify: `apps/api/src/modules/fraud/fraud.service.ts`
- Modify: `apps/api/src/modules/fraud/fraud.service.test.ts`
- Modify: `apps/api/src/modules/fraud/fraud.router.ts`
- Modify: `apps/api/src/modules/fraud/fraud.router.test.ts`

**Interfaces:**
- Consumes: `enqueueManualFraudScan` (Task 7), `recordAuditLog` (`../../middleware/audit-log.js`, already imported in `fraud.service.ts`).
- Produces: `fraudService.triggerManualScan(actorId: string): Promise<{ jobId: string | null }>`; `POST /api/fraud/run` (super_admin only) → `202 { data: { job_id, message }, error: null, meta: null }`.

- [ ] **Step 1: Write the failing service test**

In `apps/api/src/modules/fraud/fraud.service.test.ts`, add a mock for the queue module near the top (alongside the existing `vi.mock('../../middleware/audit-log.js', ...)` — check the file for its exact existing mock list first and add to it rather than duplicating):
```ts
vi.mock('../../queues/fraud.queue.js', () => ({
  enqueueManualFraudScan: vi.fn(),
}));
```
Then add:
```ts
describe('fraudService.triggerManualScan', () => {
  it('enqueues a manual_scan job and records an audit log entry', async () => {
    const { enqueueManualFraudScan } = await import('../../queues/fraud.queue.js');
    vi.mocked(enqueueManualFraudScan).mockResolvedValue({ id: 'job-123' } as never);

    const result = await fraudService.triggerManualScan('admin-1');

    expect(enqueueManualFraudScan).toHaveBeenCalledWith({
      evaluationDate: expect.any(String),
      requestedBy: 'admin-1',
    });
    expect(result).toEqual({ jobId: 'job-123' });
  });

  it('returns jobId: null when the job has no id (defensive — BullMQ always assigns one in practice)', async () => {
    const { enqueueManualFraudScan } = await import('../../queues/fraud.queue.js');
    vi.mocked(enqueueManualFraudScan).mockResolvedValue({ id: undefined } as never);

    const result = await fraudService.triggerManualScan('admin-1');

    expect(result).toEqual({ jobId: null });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/fraud.service.test.ts
```
Expected: FAIL — `fraudService.triggerManualScan is not a function`.

- [ ] **Step 3: Implement in `fraud.service.ts`**

Add the import:
```ts
import { enqueueManualFraudScan } from '../../queues/fraud.queue.js';
```
Add the method to the `fraudService` object (after `escalateAlert`, before the closing `};`):
```ts

  async triggerManualScan(actorId: string): Promise<{ jobId: string | null }> {
    const evaluationDate = new Date().toISOString();
    const job = await enqueueManualFraudScan({ evaluationDate, requestedBy: actorId });

    await recordAuditLog({
      action: 'FRAUD_MANUAL_SCAN_TRIGGERED',
      entityType: 'fraud_scan',
      entityId: job.id ?? null,
      actorId,
      actorRole: ACTOR_ROLE,
      branchId: null,
      afterState: { evaluation_date: evaluationDate, job_id: job.id ?? null },
    });

    return { jobId: job.id ?? null };
  },
```

- [ ] **Step 4: Run it to verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/fraud.service.test.ts
```
Expected: PASS, all tests including the 2 new ones.

- [ ] **Step 5: Write the failing router tests**

In `apps/api/src/modules/fraud/fraud.router.test.ts`, add `triggerManualScan: vi.fn()` to the existing `vi.mock('./fraud.service.js', ...)` mock object's `fraudService`. Then add `{ method: 'post', path: '/run' }` to the `protectedRoutes` array in the `'fraud routes — authentication'` describe block (so the existing 401 `it.each` test covers it automatically). Then add a new describe block:
```ts
describe('POST /run — role guard and behavior', () => {
  it('returns 403 for supervisor', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'post', '/run');
    const token = generateSupervisorToken([randomUUID()]);
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 for staff', async () => {
    const handlers = getRouteHandlers(fraudRouter, 'post', '/run');
    const token = generateStaffToken(randomUUID());
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('enqueues a scan and returns 202 with the job id for super_admin', async () => {
    vi.mocked(fraudService.triggerManualScan).mockResolvedValue({ jobId: 'job-123' });
    const handlers = getRouteHandlers(fraudRouter, 'post', '/run');
    const userId = randomUUID();
    const token = generateSuperAdminToken({ userId });
    const req = mockReq(authHeader(token));
    const res = mockRes();

    await runHandlers(handlers, req, res);

    expect(fraudService.triggerManualScan).toHaveBeenCalledWith(userId);
    expect(res.status).toHaveBeenCalledWith(202);
    expect((res as Response & { jsonBody?: unknown }).jsonBody).toEqual({
      data: { job_id: 'job-123', message: 'Fraud detection scan enqueued' },
      error: null,
      meta: null,
    });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/fraud.router.test.ts
```
Expected: FAIL — `No route registered for POST /run`.

- [ ] **Step 7: Implement in `fraud.router.ts`**

Add the new route (after the `escalate` route, before `export { router as fraudRouter };`):
```ts

router.post('/run', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = await fraudService.triggerManualScan(req.user.user_id);
    res.status(202).json({ data: { job_id: result.jobId, message: 'Fraud detection scan enqueued' }, error: null, meta: null });
  } catch (error) {
    handleFraudError(error, res, next);
  }
});
```

- [ ] **Step 8: Run it to verify it passes**

Run:
```bash
pnpm --filter @potato-corner/api exec vitest run src/modules/fraud/fraud.router.test.ts
```
Expected: PASS, all tests including the 3 new ones plus the extended `it.each` 401 coverage.

- [ ] **Step 9: Typecheck**

Run:
```bash
pnpm --filter @potato-corner/api run type-check
```
Expected: passes.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/modules/fraud/fraud.service.ts apps/api/src/modules/fraud/fraud.service.test.ts apps/api/src/modules/fraud/fraud.router.ts apps/api/src/modules/fraud/fraud.router.test.ts
git commit -m "feat(fraud): add Super-Admin-only manual scan trigger endpoint"
```

**Deviation protocol:** If `fraud.router.test.ts`'s `protectedRoutes` array or its `mockReq`/`mockRes`/`getRouteHandlers` helpers have a different shape than shown (the file may have evolved), read it in full before editing — the shape shown here matches what Task 1 through the audit already confirmed exists; adapt syntax, not the assertions' intent (403 for supervisor/staff, 202 + job_id for super_admin, 401 with no token).

---

### Task 9: End-to-end verification

**Dependencies:** Tasks 1–8 complete.

**Files:** none — verification only.

- [ ] **Step 1: Regenerate the Prisma client one more time (in case Task 2 ran before other schema-touching work landed on this branch)**

Run:
```bash
pnpm --filter @potato-corner/api run prisma:generate
```
Expected: succeeds with no errors.

- [ ] **Step 2: Build the shared package**

Run:
```bash
pnpm --filter @potato-corner/shared run build
```
Expected: succeeds — this is required before the API's typecheck/tests can see the new `FRAUD_SCAN_FAILED` export from Task 6.

- [ ] **Step 3: Full monorepo typecheck**

Run:
```bash
pnpm run type-check
```
Expected: 0 errors across every workspace (`turbo run type-check` fans out to `apps/web`, `apps/api`, `packages/shared`, `packages/config`).

- [ ] **Step 4: Full API test suite**

Run:
```bash
pnpm --filter @potato-corner/api run test
```
Expected: every test passes, including this plan's new files:
- `src/lib/encryption.test.ts` (4 new)
- `src/modules/transactions/transactions.service.test.ts` (+2)
- `src/modules/transactions/transactions.repository.test.ts` (+4)
- `src/modules/cash/cash.repository.test.ts` (+2)
- `src/modules/fraud/fraud.repository.test.ts` (+5)
- `src/modules/fraud/rules/*.test.ts` (7 new files, ~20 tests)
- `src/modules/fraud/detection.service.test.ts` (8 new)
- `src/queues/fraud.queue.test.ts` (7 new)
- `src/modules/fraud/fraud.service.test.ts` (+2)
- `src/modules/fraud/fraud.router.test.ts` (+3, plus 1 route added to the existing 401 `it.each`)

Note the exact pass count reported (whatever the API suite's total was immediately before this plan started, plus roughly 55–60 new tests) — do not compare against a number invented ahead of time; record what the test runner actually reports.

- [ ] **Step 5: Full web test suite (should be unaffected — no frontend files touched by this plan)**

Run:
```bash
pnpm --filter @potato-corner/web run test
```
Expected: passes at the same count as before this plan started — this plan makes no frontend changes (the review UI was already complete per the audit).

- [ ] **Step 6: Lint**

Run:
```bash
pnpm run lint
```
Expected: 0 errors. If ESLint flags anything in the new files (e.g. import ordering), fix it directly — do not disable the rule.

- [ ] **Step 7: Record and report**

Document, in the task's completion notes (not a new file — report in the same channel this plan is being executed from):
- Total API test count before vs. after this plan.
- Whether `prisma:generate` in Step 1 succeeded against a real database or only validated schema syntax (per Task 2's deviation protocol, a sandboxed environment without live Postgres is expected to only get the latter).
- Confirmation that `pnpm run type-check` and `pnpm --filter @potato-corner/api run test` both exited 0.

**Deviation protocol:** If any test fails, do not mark this task complete and do not silence the failure by loosening an assertion — return to the specific task/step whose code the failing test belongs to, fix the implementation (not the test) unless the test itself is provably wrong (e.g. it asserts a value this plan's own Corrections section already flagged as needing re-verification), and re-run Steps 3–6 from the top before reporting completion.
