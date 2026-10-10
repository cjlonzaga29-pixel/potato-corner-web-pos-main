# POS-PERF-P30R2 — Delayed-Sale Cashier Attribution and Concurrency-Test Investigation

## Starting / final state

- Starting local HEAD: `16c55213326d3a0f1bd3168423c32e707a57576b` (2 commits ahead of `origin/main`, clean working tree).
- Final local HEAD: see the commit this report ships alongside — one commit ahead of the starting SHA above (new test + this doc only; no production code changed).
- `DATABASE_URL`/`DIRECT_URL` verified pointing at `127.0.0.1:5432/pos_verify` (the same disposable local Postgres used throughout P30/P30R) before any test run. API (port 4000, `tsx watch`) and web (port 3000, `next dev --turbopack`) were found already running against this stack from a prior session; the web process had crashed (500s on every route) and was restarted — a reversible, local-only action, no data touched. No production connection string was used at any point.

## Part 1 — Real delayed-sale cashier attribution

### Code read before testing

Traced the full path a Charge click takes: `handleCharge` (`terminal/page.tsx`) → `createTransaction.mutateAsync` (`useCreateTransaction`, `use-transactions.ts`) → `apiClient` with `accessTokenOverride` → `POST /api/transactions`, plus the "Next Customer during saving" detach path (`handleNewSale` → `lib/detached-sales.ts`) and its resolution (`handleCharge`'s own try/catch, gated on `detachedKeysRef`).

Two mechanisms are what make correct attribution possible, confirmed by reading before writing any test:

1. **`accessTokenOverride` is captured by value, not by reference, at the moment `mutateAsync` is called.** `useCreateTransaction(operatorToken, refreshEmployeeToken)` is called fresh on every render with whatever `operatorToken` is live *that render*; its `mutationFn` closes over that specific value. A `mutateAsync()` call started under cashier A's token keeps using A's token for its entire lifetime (including any 401 retry), regardless of how many Switch-Cashier/PIN-reverify renders happen afterward — this is what lets the server's `req.user.user_id`-derived `cashier_id` attribution (`transactions.router.ts`) stay correct for a request that outlives the identity that started it.
2. **`detachedKeysRef` routes a request's eventual settlement away from shared terminal state once it's been detached.** `handleNewSale` (clicked via "Next Customer" while `salePhase === 'saving'`) persists a `DetachedSale` record and adds the idempotency key to `detachedKeysRef.current` *before* clearing the cart. `handleCharge`'s own `try`/`catch` — the same invocation that's still awaiting the original `mutateAsync()` call — checks this ref on settlement: if present, the result updates that `DetachedSale` record (and fires a toast) instead of the singleton `saleSnapshot`/`saleTransaction`/`salePhase` state that whatever cashier is *currently* at the terminal is looking at.

No gap was found in either mechanism by reading alone — Part 1's job was to prove it with a real browser against a real server, and to verify the test actually detects a regression if either mechanism were absent (see "Verifying the test itself" below).

### Real-browser test

New spec: `tests/e2e/pos-perf-p30r2-delayed-sale-attribution.spec.ts`. Run against the local disposable stack described above (not production accounts/storage/data). Uses the branch's pre-existing seeded "Water" variant (₱35.00, `readiness_code: READY`, no flavors/option groups, a real recipe/BOM mapping and real on-hand stock) so checkout exercises genuine inventory deduction, not a no-op.

**Technique for holding a real response:** Playwright's `route.fetch()` / `route.fulfill()` split. The route handler calls `route.fetch()` for the *first* POST to `/api/transactions` it sees — this sends the real request and the real server processes and persists it — but does not call `route.fulfill()` until the test explicitly releases a gate promise. The browser never sees the response until release; the server already committed it. Any *second* POST (Bob's) passes straight through via `route.continue()`.

**Scenario, exactly as specified:**
1. Cashier Alice (A) unlocks with her PIN, clocks in, adds one Water, and clicks Charge. Her request is captured by the route handler and held.
2. Alice clicks "Next Customer" while the 'saving' popup is still showing — confirmed via a direct `localStorage` read (`pos:detached-sales:<branchId>`) that this actually persisted a `DetachedSale` record with `status: 'saving'`, not just closed the popup.
3. With the cart now empty (detach clears it), Alice clicks "Switch Cashier" — confirmed via the Attendance API that her attendance record is still open (never a clock-out).
4. Cashier Bob (B) unlocks with his own PIN, clocks in independently, adds one Water, and charges — his request completes normally while Alice's remains held (asserted: `aliceResponseReleased === false` at this point).
5. Bob's own "Sale completed" popup is deliberately left **open on screen** (not dismissed) — Order #02 (the terminal-local counter; Alice's was #01, `lib/order-reference.ts`) — through the next step. This is the actual hazardous window the `detachedKeysRef` check guards: a late response for an order the cashier already walked away from must never overwrite/reopen whatever the *current* cashier is looking at right now.
6. Alice's held response is released.

**Assertions, all passing against the real (unmodified) code:**
- Exactly one sale exists per idempotency key — proven by independently fetching both `aliceTransactionId` and `bobTransactionId` back via `GET /api/transactions/:id` and confirming each resolves to itself with no collision.
- Alice's sale is attributed to Alice (`cashier_id === aliceUserId`); Bob's to Bob. Confirmed via the server's own `cashier_id`, not a client-side label.
- Bob remains the active cashier throughout, including after release (`"Who's working?"` never reappears, `"Current Cashier:"` / `/Bob Cashier/` stay visible).
- Bob's own popup (Order #02) is **unchanged** by Alice's release — order ref #01 never appears, #02 stays visible. Going one layer deeper than the popup's own text: clicking "View Receipt" after the release still shows **Bob's own `receipt_number`**, not Alice's — this specifically catches a scenario where the detach guard only protects the `SaleStatusModal`'s snapshot text but a stray `setSaleTransaction()` call still silently swaps out the receipt the cashier would actually print.
- Bob's attendance stays at exactly one open record (Alice's late response resolving never clocks either cashier out as a side effect).
- Inventory reconciles for both independently: both transactions' `inventory_deduction_status` are polled until no longer `'pending'`, then asserted `'completed'` — proving the deduction worker correctly processed two genuinely separate sales under the race, not a lost/duplicated job.

**Verifying the test actually catches a regression (not a vacuous pass):** temporarily short-circuited the `detachedKeysRef.current.has(idempotencyKey)` check in `handleCharge`'s success branch (`if (false && detachedKeysRef.current.has(idempotencyKey))`) so a late response always falls through to the singleton state, simulating "what if this guard didn't exist." The order-ref/dialog-visibility assertions alone did **not** catch this — the `SaleStatusModal` renders purely from `saleSnapshot`, which the buggy fallthrough branch never touches, so the popup text stayed correct even with the guard disabled. Only the deeper **"View Receipt" / `receipt_number`** assertion caught it: with the guard disabled, clicking "View Receipt" on Bob's still-open dialog showed **Alice's** receipt number (confirmed via the captured failure: `expect(locator).toBeVisible()` failed waiting for Bob's real receipt number, because the `saleTransaction` state had been silently overwritten with Alice's transaction object). Restored the real code (`git diff` on `terminal/page.tsx` confirmed byte-identical to HEAD afterward — no production code changed in the final commit) and re-ran: passes. This is the same "prove the test isn't a false positive" standard POS-PERF-P30R's own regression test met.

**Result:** no defect found. The existing architecture (token-value-capture + `detachedKeysRef` routing) already satisfies every requirement in the task's scenario. The new test is a permanent regression guard for both mechanisms together, distinct from the existing `terminal/page.test.tsx` stale-401-refresh unit test and the P30R e2e suite's Switch-Cashier-without-clock-out coverage — neither of those exercises a *delayed successful* response crossing a cashier switch.

## Part 2 — Investigation of the previously-reported universal-inventory concurrency failure

### What was asked

Identify the exact test, preserve its failure evidence, and determine whether the single prior failure (`successes.length >= 1` got `0`, all 6 concurrent HTTP calls returning non-2xx, recorded in `pos-perf-p30r-session-security-verification.md` Part 4) was test-isolation/configuration, a timeout, or a genuine concurrency defect — without inventing a diagnosis if the original failure output is unavailable.

### Limitation, stated up front

**The original failure's raw output (stack trace, HTTP response bodies, Prisma query log, or process RSS/connection metrics from that run) was not preserved anywhere this session has access to** — the prior report only kept a summary (counts and the one-line assertion diff), not the full log. This investigation could not start from that artifact; it could only attempt to reproduce the failure fresh.

### Reproduction attempts and captured evidence

| # | Configuration | Result |
|---|---|---|
| 1 | Full `apps/api` suite, default `vitest run` (concurrent with a live pg_stat_activity poll every 3s) | **150/150 files passed**, including the target test. Peak observed Postgres connections for `pos_verify`: **12** (of `max_connections = 100`). |
| 2 | Full `apps/api` suite, default config, repeated | **150/150 passed.** |
| 3 | Full `apps/api` suite, forced `--poolOptions.threads.maxThreads=8 --poolOptions.threads.minThreads=8` (double this machine's 4 logical CPUs, to deliberately increase concurrent-worker/PrismaClient pressure) | **150/150 passed.** |
| 4 | Full `apps/api` suite running **simultaneously** with the new Part 1 Playwright browser test plus `pos-workflow.spec.ts` (closest reconstruction of the original session's "API+web dev servers and E2E all live at once" condition) | **150/150 passed** (the API suite); the new Part 1 spec passed again under this combined load. |
| 5 | The target file alone, `vitest run` × 5 consecutive invocations | **5/5 passed** (matches the prior report's own isolated-rerun finding — not re-litigated as new evidence, listed for completeness). |

Total: **9 reproduction attempts across this session, 0 reproductions of the original failure.**

### What the connections measurement rules out

The prior report's own leading hypothesis — Postgres connection-pool pressure from many concurrent `PrismaClient` instances across 164 test files exhausting the pool — predicts elevated connection counts under full-suite load. Attempt #1's live measurement directly contradicts this for *this* environment/session: connections never exceeded 12 of a 100-connection budget at any 3-second sample across the entire ~140s run. This does not prove connection pressure was never the cause in the *original* session (a different machine/load state, long since gone) — it only establishes that the specific mechanism proposed is not reproducible as the explanation here, with real measurement rather than a restated guess.

### Conclusion

No genuine concurrency defect in the mutex/idempotency logic was found or reproduced. The actual mutex path (`unique constraint failed on (idempotency_key, actor_user_id)` for losing concurrent callers, caught and turned into a cache-lookup-and-replay) was observed firing correctly in every one of the 14 total runs (9 full/high-load + 5 isolated) in this session's logs, including the runs deliberately engineered to be the heaviest. Per this task's own instruction not to invent a diagnosis when the original evidence is unavailable: **this is reported as an unreproduced, now-presumed-transient single prior failure, not a confirmed external-resource-contention diagnosis and not a confirmed logic defect.** No change was made to the test or to `universal-inventory.service.ts`'s adjustment/mutex code — there is nothing established to fix, and weakening or restructuring a currently-passing, correctly-asserting concurrency test with no reproduced defect would violate this task's "do not serialize the race to make it pass" / "do not weaken assertions without evidence" constraints in the other direction (removing real coverage to chase a ghost).

**Recommendation for a future session, if this resurfaces:** capture the full `vitest` stdout/stderr (not just counts) and a `pg_stat_activity` snapshot *at the moment of failure* before concluding anything — this session's inability to reproduce does not retroactively prove the original failure didn't happen, only that it isn't currently reproducible with the evidence available.

## Part 3 — Final validation

- **New browser scenario** (Part 1): 1/1 passed, including under combined full-API-suite + other-e2e-spec load (attempt #4 above). Not re-executed redundantly beyond what was needed to (a) prove it passes with real code and (b) prove it fails with the guard disabled and passes again once restored.
- **`apps/api`**: `tsc -p tsconfig.json --noEmit` clean. `eslint .` clean (0 errors; 296 pre-existing `no-console` warnings, unchanged from P30R's own baseline — this task touched no `apps/api` source). Full `vitest run`: **150/150 files, 2764/2764 tests passed** (164 total, 14 skipped — pre-existing, gated on an unset `TEST_DATABASE_URL`/`TEST_REDIS_URL` env convention predating this task, not something this task's scope touched or broke).
- **`apps/web`**: `tsc --noEmit` clean. `eslint .` clean (0 errors; 1 pre-existing `@next/next/no-img-element` warning in an untouched file, same as P30R's baseline). Full `vitest run`: **133/133 files, 1168/1168 tests passed** — unchanged from P30R's own baseline, confirming this task introduced no regression (no `apps/web` source file differs from HEAD).
- **Rebuild**: not performed — no production source changed in either package, so there is nothing a rebuild would pick up beyond what `tsc --noEmit` already confirmed compiles cleanly.
- `tests/e2e/` is not a pnpm workspace package (`pnpm-workspace.yaml` only includes `apps/*`/`packages/*`) and has no `tsconfig.json`/`eslint` config of its own — it sits outside both the `type-check` and `lint` Turbo tasks entirely, same as every other file already in that directory. This is a pre-existing project-structure fact, not something this task changed or should change on its own initiative.

## Remaining concrete blockers

- None introduced by this task. Part 2's unreproduced prior failure is explicitly **not** closed out as "fixed" or "confirmed harmless" — see Part 2's conclusion — and should be treated as an open, low-confidence item if it resurfaces, not re-cited as resolved.
- The `TEST_DATABASE_URL`/`TEST_REDIS_URL`-gated integration test files (14, skipped in every run this session) are a pre-existing environment-configuration gap unrelated to this task's scope; noted here only because they were visible in every full-suite run's output, not investigated or changed.

## Files changed

```
tests/e2e/pos-perf-p30r2-delayed-sale-attribution.spec.ts   (new, real-browser verification)
docs/runbooks/pos-perf-p30r2-attribution-and-concurrency.md (new, this file)
```

No `apps/web` or `apps/api` source files changed.
