# POS-PERF-P62 — Performance and reliability

Branch `feat/pos-perf-p62-performance-and-reliability`, local only: not pushed, no PR, nothing deployed, production not accessed.

**Not release-ready.** The code-level work is done and was verified in a real browser on a local stack, including the business flows. The readiness batch (§12) closed the local gaps: requests before session restore, the session driver, on-screen totals, PDF admission and layout, and two test-isolation causes. What still blocks a combined release is in §11: hosted-only checks (NOT RUN), owner decisions on PDF capacity and the Extra Supplies rollback procedure, and the unexplained intermittent test failures listed in §12.

## 0. SHAs and dependencies

| | SHA |
| --- | --- |
| Started from | `42bd3eb` ("TASK TRACKER": untested PDF worker code plus an accidental `.vscode/settings.json` change), parent `fa31ede` (P61 docs) |
| Settings correction | `1be724e` |
| First P62 batch | Auth `8a4fc17` · Rate limit `f3e16ad` · PDF `6151684`, `abd2cc2` · Web `4febdd6`, `6fd5f8d` · Tests `780c5b1` · Lint `a0be182` · Docs `a54321f` |
| This batch, start | `a54321f` |
| Test runner exit status | `db80eb0` |
| Test fixes | `c8ae908` (web React copies), `09d428b` (API), `a763a10` (web timeouts) |
| Fixture without raw SQL | `5f5e6bc` |
| Service worker purge on takeover | `1fc4df9` |
| Rollback rehearsal | `58c469a` · Proxy trust test `3eb29c2` |
| Session cookies cleared when over | `1c259fb` · Logout budget `115cb0f` |
| PDF request deadline | `197aaca` |
| Drivers and evidence | `8ace34a`, `08fcea4` |
| Browser, terminal, PDF load, navigation | builds at `197aaca` |
| Final suites, typecheck, lint, builds | `08fcea4` (same code as `197aaca`) |
| **Readiness batch (§12), start** | `119e321` |
| Request gating · PDF layout · PDF admission | `483d49e` · `e52206d` · `e8bae36` |
| Drivers · test isolation · route test · selector | `d5b65e2` · `440ef2e` · `5952a62` · `032d07b` |
| **Final application code, tested** | `032d07b` (web build, browser gating recheck, full web suite); API code unchanged since `e8bae36` (API build, browser, PDF and full API run 2 at `5952a62`, test-only changes after) |

P62 sits on unpushed P61 → P60 → P59 (see their runbooks). Merging P62 brings all of them in.

**Settings:** `1be724e` restores the tracked `.vscode/settings.json` to `fa31ede`; the owner's copy stays modified and unstaged. `git diff fa31ede HEAD -- .vscode/settings.json` is empty.

## 1. Authentication

Each cause was reproduced by a test that failed on the old code path. Tests: `API/auth/p62-refresh-protocol.integration.test.ts` (real Postgres and HTTP), `API/auth/auth.service.test.ts`, `API/middleware/rate-limiter.test.ts`, `WEB/lib/api-client.test.ts`.

| Cause found | Fix |
| --- | --- |
| The rotation cache was read **before** the presented token was checked, so a rotated token collected its successor from another device, after expiry, or after revocation | Every check runs first: the token exists, is unexpired, is on this device, and its user is active and operational |
| The cache window started at the transaction's start, so lock waits shortened it (plausibly the P61 run 9 sign-out) | `createdAt` set explicitly; window `ROTATION_GRACE_MS` = 30s |
| Logout revoked only the cookie's token, leaving a live successor after a lost refresh reply | Logout revokes every live token of that user on that device |
| A logged-out access token stayed accepted for up to 60s from an in-process cache | Revocation evicts the entry (`forgetNotRevoked`) |
| A real replay only logged | Replay revokes the device session (returned, then thrown, so the transaction doesn't roll it back) |
| The cache held plaintext access and refresh tokens for up to 1h | Only the successor, encrypted; pruned after 30s |
| Web: any refresh failure signed the user out | Only `REFRESH_INVALID`/`REFRESH_MISSING` (401) and `ACCOUNT_INACTIVE`/`BRANCH_INACTIVE`/`BRANCH_ASSIGNMENT_REMOVED` (403) sign out; otherwise 503 `SESSION_UNCONFIRMED` and the user stays signed in |
| Web: every 401 was refreshed and **sent again**, a wrong PIN included | Refresh only on `TOKEN_*` codes or a non-JSON 401 |
| **New, browser run:** a session ended server-side (revoked, replayed, logged out elsewhere, deactivated) kept its `refresh_token` and `pc_access_hint` cookies. The web middleware routes `/login` from the unexpired hint, so the signed-out browser was sent back to a dead dashboard and looped until the hint expired (up to 15 min). No data was exposed: every refresh got 401 | `/api/auth/refresh` clears both cookies on those final outcomes, as logout does. Transient failures keep them (`1c259fb`) |
| **New, browser run:** a logout refused with 429 kept the server session and cookies, so "Log out" appeared to do nothing (same middleware loop). All terminals of a branch share one account's 300/min | A verified user's logout and logout-all use a separate per-user budget of 30/min; unverified callers stay on the per-IP limit (`115cb0f`) |

**Protocol.** One advisory lock per device session covers refresh, replay revocation and logout. A rotated token gets its successor back only from the same device, while the successor is unused, unexpired and unrevoked, the cache row is under 30s old, and the user is still allowed in. Anything else is a replay and revokes the device session. 30s is about twice the longest client wait (15s abandon, two 8s middleware attempts). Refresh tokens stay in the HttpOnly cookie, never in localStorage. Tabs take turns under a Web Lock.

## 2. Cross-user cache isolation and the service worker

- **Query cache:** `identityEpoch` changes on sign-out or a different user; `useIdentityScopedQueryCache` cancels every query and clears the cache. Responses started under an earlier identity are dropped (`IDENTITY_CHANGED`).
- **IndexedDB is left alone:** offline sale queue, drafts and unresolved operations survive and keep their attribution.
- **Service worker:** next-pwa's default `apis` rule cached every same-origin `GET /api/*` for 24h, keyed by URL only, and served it offline. `next.config.ts` replaces it with `NetworkOnly`.
- **Upgrade purge:** `purgeApiResponseCache` deletes `apis` and any stored `/api/` response at start-up and on each identity change. **New (`1fc4df9`):** it also runs when a new service worker takes control (`controllerchange`) and once more 5s later. The browser run showed why: during the first load after an upgrade, the old worker still controls the page while the new one installs, and it keeps caching after the start-up purge.

**Browser evidence** (`evidence/browser/auth-cache-*.json`). Old web built with `fa31ede`'s `next.config.ts` (the only file that defines the service-worker rules); current web at `197aaca`; same origin and browser profile.

| Check | Result |
| --- | --- |
| Old build: authenticated responses stored | Yes, 5 Supervisor responses in `apis` |
| Old build, offline, `fetch` **with no Authorization header** | **200 from the cache: the risk is real** |
| Upgrade with the old worker held in control 8s (update check delayed) | The old worker wrote **13** new entries during that window |
| After the new worker took control (6.5s), **no reload** | **0** API entries left; `apis` cache gone |
| Every Supervisor page browsed on the new build | 0 API responses stored |
| Offline, same request | Fails; not answered from any cache |
| Session across the upgrade | Kept |

An earlier run without the hold (takeover 3.1s) wrote nothing in the window, so it didn't exercise the fix. The held run does. The first upgrade run, on the build before `1fc4df9`, found 4 entries after a reload made during install. That reload happened while the old worker still controlled the page, so it showed the window existed but not whether entries outlived the takeover.

**Limitation:** the "old" build's page code was current code (with the start-up purge); only its service worker was `fa31ede`'s. A real `fa31ede` page has no purge at all, so its cache stays until the new build's first load, which is the case tested.

**Session checks in the browser** (`auth-session.json`, Supervisor, service worker active): 10 / 11.

| Check | Result |
| --- | --- |
| Two reloads during a 6s refresh | Signed in |
| Three tabs reloading together | All signed in |
| Refresh answered 503, 429, gateway HTML 502, network failure | Signed in during and after each |
| Logout, then the pre-logout cookies put back | `401` with both cookies cleared, then `/login`. **Failed before `1c259fb`** (dead dashboard loop) |
| A logs out with 26 of A's GETs held in flight, then B (Admin) signs in | B on the Admin dashboard; no API response cached |
| No 429 from the API during the run | Flagged failed: all 10 429s were the driver's own injected "refresh 429" scenario. The API log shows no 429 between the run's start and end. The driver now excludes injected ones |

Earlier session runs that failed: logout got 429 (→ `115cb0f`); the driver tripped the per-IP budget (paced since); and a driver bug that let a detail field overwrite the verdict in the results file (fixed).

## 3. PDF isolation, bounds and failure messages

Every PDF (report, transactions, expenses, inventory summary, payroll, and the background report queue) renders in a worker thread (`lib/reports/pdf-render-pool.ts`). A static test fails if anything but the worker imports a renderer or calls `renderToBuffer`. Every PDF route was rechecked in this batch: none bypasses the worker.

| Bound | Default |
| --- | --- |
| Rendering at once / queued | 1 / 4; beyond that `PDF_BUSY` (503, Retry-After 60) |
| **Interactive request deadline (new)** | **25s** (`PDF_REQUEST_DEADLINE_MS`), from the request reaching the route: still queued → `PDF_BUSY`, rendering → `PDF_TIMEOUT` with the thread terminated |
| Queue wait / render / start-up | 60s / 120s from worker ready / 60s (the background queue keeps these) |
| Input / output | 32 MB / 64 MB, `PDF_TOO_LARGE` (413) |
| Client leaves | Render cancelled |

**Why the deadline (`197aaca`).** Measured through the web's `/api` rewrite (the path browsers use; Vercel rewrites the same way): every Transaction PDF not done by **30.0s** came back as a **bare non-JSON 500**. That's the Next.js proxy's limit, so the user never saw the actionable message. A 7-day export for the busy fixture branch (1,436 rows) takes **18–21s alone**, so the second one in the queue was always cut off. After the fix, through the same proxy:

| Load | Before (`115cb0f`) | After (`197aaca`) |
| --- | --- | --- |
| 1 export | 500 at 30.1s (cold worker) | 200 in 19.7s |
| 3 at once | 1× 200 (21.1s), 2× **500 at 30.0s** | 1× 200 (17.8s), 2× `503 PDF_TIMEOUT` at 25.06s |
| 6 at once | 1× 200, 1× `PDF_BUSY` (2.5s), 4× **500** | 1× 200, 2× `PDF_BUSY`, 3× `PDF_TIMEOUT`, all JSON |
| Sustained: 4 rounds of 3, back to back | — | **2 of 12** succeeded; 10 refused cleanly |

Messages: `PDF_TIMEOUT` "This PDF took too long to make and was stopped. Choose a shorter date range, or download a CSV." `PDF_BUSY` "Several PDFs are being made right now, so this one was not started. Try again in a minute, or download a CSV." Web fallbacks for a non-JSON failure (a proxy that answers first) now say "The file could not be made. Try again, choose a shorter date range, or download a CSV." No empty or corrupt file is ever handed over: the clients check `%PDF-` and size. Coverage labels and filtered totals are unchanged. **No row cap was changed.**

**API main thread during PDF load** (`/health` probed every 50ms): idle worst gap 82ms; 1 export 538ms; 3 at once 734ms; 6 at once 1,225ms. Rendering is off-thread; the remaining stalls come from the routes' reads and from serialising rows to the worker. Before P62 the request thread itself stalled 2.9–5.8s (first benchmark, below).

**Rendered output, inspected as images and text** (`evidence/browser/transactions-pdf-page-1.png`): the 7-day Transaction PDF has 120 sheets for 1,436 rows, with scope line, filters, repeated header, money values and "Page n of 120". All 1,436 transaction numbers are in the extracted text (1,428 fixture rows plus the 8 sales the terminal driver made). The dash for "not recorded" renders correctly but extracts as U+FFFD (the font's character map lacks it), which only affects copy and paste.

**Measured layout limit, not changed:** only **12 rows per sheet**, as each row is drawn about twice its text height. That's why a week of a busy branch needs 120 sheets and ~20s, close to the 25s deadline. Denser rows would roughly halve render time, but they change the PDF's look: owner decision (§11).

First benchmark (`evidence/pdf-render-benchmark.json`, `a0be182`, machine at 100% CPU from other work): request thread 4.0–7.0s total and **2.9–5.8s stall** for 100 rows; worker 5.1–7.2s total, **25–161ms** stall.

## 4. Rate limits and proxy trust

| Limiter | Behaviour |
| --- | --- |
| `apiLimiter` | Verified RS256, unexpired bearer: per user, 300/min. Anything else: per IP, 100/min |
| Logout, logout-all (new) | Verified user: own per-user budget, 30/min. Unverified: per IP as above |
| Login, PIN, 2FA, reset, receipt lookup, select-employee | Unchanged, on top (select-employee: 10 per 15 min per branch session) |

**Proxy trust, local simulation** (`API/p62-proxy-trust.test.ts`, real HTTP, the app's own setting): `trust proxy` is exactly 1 hop. With no header `req.ip` is the socket peer; through one trusted hop it's the address that hop appended; client-supplied entries left of it are ignored; and the real per-IP limiter is not reset by a spoofed prefix (101 requests with different spoofed prefixes → 429; a different real hop is unaffected). **With two proxies in front (Vercel, then Render), `req.ip` is the first proxy, not the client.**

**Hosted behaviour is not verified.** Staging checklist (needs separate authorization; no diagnostic endpoint should be deployed):

1. On staging, sign in from two different networks at once and confirm each has its own unauthenticated budget: 101 failed logins from network A must not block login from network B.
2. From Render's logs (not a new endpoint), compare the logged client address for requests that arrive via the Vercel rewrite against the real client IP.
3. If Render sees Vercel's egress address, decide between `trust proxy` 2 (only if Vercel's forwarded address is reliable) and keying unauthenticated limits differently. Don't trust `X-Forwarded-For` blindly.
4. Confirm the hosted proxy's timeout for long responses, against the 25s PDF deadline.

## 5. Rollout and rollback

**Schema:** no migration in P62. **Order:** API, then web (either order works).

| Situation | Effect |
| --- | --- |
| New API, rotation rows written by the old API | Rows older than 30s are ignored; a plaintext row inside its window fails to decrypt (401): at most one sign-out per session mid-refresh |
| Roll the API back to pre-P62 | A session mid-refresh is signed out once; every §1 defect returns |
| New web, old API | Works; the old API doesn't clear cookies on a dead session, so the §1 middleware loop can return until the hint expires |
| Roll the web back | The old service worker's `apis` cache returns; purge can't run without the new page code |

### Extra Supplies (P61) rollback, rehearsed (`58c469a`)

Run on a disposable local database at the current schema (P61 migration applied), with **real pre-P61 code**: `500e97e`, exported with `git archive` (no worktree, no checkout) and installed offline in isolation. The same script drives both versions through their own service layers (`apps/api/scripts/p62-rollback-rehearsal.ts`; results in `evidence/extra-supplies-rollback-rehearsal.json`). Ordinary sales were inserted as completed transaction rows; supply issues went through the real P61 service.

Open shift: opening ₱1,000; cash sales ₱120 + ₱80; GCash sale ₱50; paid cash supplies ₱20 + ₱5 (the ₱5 one an "uncertain" issue whose reply the client never received); 3 free cups; GCash supply ₱10. The drawer really holds ₱1,225.

| Step | Code | Result |
| --- | --- | --- |
| Live summary | current | expected cash **₱1,225**; supply cash 25, supply collections 35, total collections 285; stock 100 → 90 |
| Live summary | **pre-P61** | expected cash **₱1,200**: supply collections are invisible, cash and non-cash |
| Close, counting ₱1,225 | **pre-P61** | **Refused** until a written explanation of at least 50 characters was given; then closed **`flagged`**, variance **+₱25** |
| Back on current code | current | All 4 issues, 4 movements and the stock figure preserved; the uncertain issue resolves as `committed`; the saved close (expected ₱1,200, variance +₱25) is **not rewritten** and shows `PENDING_REVIEW` next to supply cash ₱25 |

The pre-P61 API has no Extra Supplies routes, so a terminal holding an unresolved supply issue can't resolve it until current code is back.

**Supported rollback target and procedure:**

- **Prohibited:** rolling the API back below P61 while any shift that has Extra Supplies collections is open.
- **Before a rollback:** close every open shift under current code, and let terminals resolve every pending supply issue (Pending tab empty).
- **If it happened anyway:** each affected shift closes flagged by exactly its cash supply collections. The supervisor approves the variance with the reason "Extra Supplies cash collected before rollback" and the issue reference numbers. Don't edit amounts or add balancing entries.
- Never drop the P61 tables. Roll forward to current code to restore supply totals in reports.

## 6. Performance (local laptop, not hosted)

Pentium Gold 7505 (4 threads, 8 GB), Windows, production builds, service worker active, fixture: 8 branches, 55,000 sales, 55,000 movements, 4,100 expenses. Nothing else running except about 24% CPU from VS Code. **These are local timings, not Render or Vercel.**

**Navigation** (`perf-nav-summary.json`; medians of 3; "cold" = first visit in a fresh profile right after sign-in, "warm" = the same full page load repeated, so both include a session restore):

| Role | Page | Cold: first data / usable / API calls | Warm: first data / usable |
| --- | --- | --- | --- |
| Admin | Dashboard | 1.67s / 3.29s / 27 | 0.74s / 2.18s |
| Admin | Products, Inventory, Reports, Expenses | 0.58–1.07s / 1.59–2.03s / 3–7 | 0.55–0.75s / 1.17–1.55s |
| Supervisor | Dashboard | 1.44s / 3.39s / 20 | 1.30s / 2.28s |
| Supervisor | Products, Inventory, Reports, Expenses | 0.65–1.22s / 1.43–2.09s / 6–16 | 0.67–1.00s / 1.50–1.92s |
| Branch | Dashboard | 1.04s / 3.06s / 13 | 0.45s / 1.60s |
| Branch | Products, Inventory, Reports, Expenses | 0.43–0.80s / 1.01–1.98s / 3–11 | 0.42–0.51s / 0.97–1.68s |

**Waterfall findings, not changed (they predate P62):**

- On every full page load, each page fires its API calls about 150ms in, **before the access token is restored** (the refresh answers at about 1.3s), then repeats them. That's 13 wasted calls per Admin dashboard load. Without a token they count against the **shared per-IP** budget, so a branch with many terminals behind one address reloading at once spends that budget. Fix: hold queries until the session restore settles.
- Supervisor `GET /api/branches` returns 401 on every page load (the same pre-restore call).
- Supervisor Dashboard and Reports call `/api/reports/daily-sales` **without `branch_id`** first (400), then correctly.

**Checkout and supplies through the terminal**, Charge or Confirm to completed (`terminal-timings*.json`; one sample per run):

| | Idle (two runs) | While PDFs render |
| --- | --- | --- |
| Cash sale, no discount | 549–758ms | 576ms |
| Sale with custom discount | 454–737ms | **1,671ms** |
| Free supply | 86–125ms | 155ms |
| Paid cash supply | 64–507ms | 95ms |

Every sale and issue under PDF load was still recorded exactly once.

**Baseline `fa31ede`:** not reproduced. It would need a second full install and build of the old web, and P62 changed no data-fetching code, so the navigation figures above are P62-only. The PDF comparison against the request-thread path (§3) is the measured before/after.

## 7. Test results

**Runner exit status, fixed first (`db80eb0`).** `embedded-postgres` registers `async-exit-hook`, whose `beforeExit` handler calls `process.exit(0)`. The runner set `process.exitCode = 1` and let the loop drain, so **every failure exited 0**. Reproduced with a child exiting 7 (→ 0) and with a real failing vitest run. Now: the child's code, 128+n for a signal, 1 for setup or migration failure, and 1 if Postgres can't be stopped after a passing run. A leftover data directory isn't fatal, and cleanup never turns a failure into success. Regression tests (`scripts/lib/test-postgres-run.test.ts`, 12) run real child processes with the real exit hook loaded, and a negative control confirmed they fail on the old behaviour. The full suite below reported exit 1 when tests failed.

### Root causes found and fixed

| Failure | Cause | Fix |
| --- | --- | --- |
| Web: "Cannot read properties of null (reading 'useEffect')" in every hook test | **Lower-case drive-letter cwd** (`c:\`, as VS Code's terminal reports it): Vite and Node resolved React under different casings, so two copies loaded. `use-auth` 15/15 failed from `c:\` and passed from `C:\`. Explains "persists across processes" and "cleared after rewriting files" (the shell changed) | `vitest.config.ts` moves the cwd and root to the real path (`c8ae908`): 19/19 from both. Linux CI unaffected |
| P61 "creates a card that owns no balance" (6 vs 4) | Counted the **whole** `inventory_stocks` table while other files created rows in parallel | Counts the file's own item |
| P60 "one set of totals" hook (10s) | 66 sequential service writes: 5.1s with two files running | Independent rows created ten at a time |
| P61 "history and reports" hook (10s) | 29 issue transactions on one stock row (they serialise on its lock): 6.0s with two files | 30s for that hook, with the measurement in a comment |
| P59 #9 and the P60 PDF test (20s) | Real worker renders including cold start: #9 is 8.7s alone, 6.0s of it the first PDF | 90s, as `780c5b1` did for the same cause |
| Payroll multi-page PDF (60s) | 32 employees rendered on the test thread, 35–40s | 10 employees still give >2 pages with both long names: 6.0s |
| Web 5s timeouts | Page-level tests take 1.0–2.4s alone (terminal: render 0.65s, checkout 0.66s, ~0.12s per role query) and about 4× longer in the full parallel suite | 15s for the four files that failed (`a763a10`); every other file keeps 5s |

### Not reproduced

- **P58 race** (`PRODUCT_TYPE_NOT_FOUND` vs `INACTIVE`): passed in every run of this batch. No code path in the race can empty a type's scope or the actor's live branches (no trigger, no scope rewrite). Cause unknown.
- **`flavors`**: passed in every run.
- **500s in `p62-refresh-protocol` once:** one run of that file with `auth.router.test.ts` gave 500 on every refresh; two reruns of the same pair and the full suite passed. The server log of that run wasn't kept. Cause unknown.

### Runs in this batch (fresh embedded Postgres each, CI-style environment from `.env.example` with fresh random keys, nothing written to `apps/api/.env`)

| Run | Result |
| --- | --- |
| Full API, default parallel, `db80eb0` | 3 failed files (P60, P61 hooks; P59 #9), 3,809 passed, 22 skipped; **runner exit 1** |
| Full web, 5s, from `c:\`, `09d428b` | 9 failed (all 5s timeouts), 1,698 passed; **no duplicate-React errors** |
| **Final full API, `08fcea4`, run 1** | **1 failed file**: P57 shortages `beforeAll` hook timed out (10s), so its 12 tests were skipped; 3,825 passed, 17 skipped; runner exit 1 |
| **Final full API, `08fcea4`, run 2** | **0 failed**, 3,837 passed, 5 skipped (opt-in measurements); runner exit 0 |
| **Final full web, `08fcea4`, default 5s, from `c:\`** | **0 failed**, 1,708 passed; exit 0; no duplicate-React errors |
| Full web, default settings, `aaae67b` code + the two test fixes (run 3) | **0 failed, 1,725 passed, 184 files; exit 0; 531.75s.** First fully green full web run on the final application code. Machine not fully idle (user's Chrome/VS Code ~55–74% CPU, ~1.2 GB RAM free) |
| Shared | 83 passed |
| Typecheck API, web, shared | Clean |
| Lint | API 0 errors (409 warnings: 4 more than before, `no-console` in the new runner scripts); web 0 errors, 5 warnings; shared clean |
| Production builds | API `tsc` and web `next build` (exit 0) at `197aaca`; no application code changed after it |

**P57 hook timeout, not fixed.** The hook needs 0.69s alone (`sharp` 15ms), and in run 1 it completed every statement before timing out, about 14× slower than alone. A longer timeout isn't justified by the hook's own work, so none was added. Probable cause: database contention in the parallel suite, not proven. It wasn't seen in the three other full runs this batch. No Postgres lock, connection or deadlock error was logged; one Windows "could not reserve shared memory region" line appeared, but minutes later.

## 8. Browser and terminal verification (local)

Local stack only (`tests/e2e/manual/p62/stack.sh`): embedded Postgres `p62_browser` on 56431, API 56432, web 56433 (outside the reserved 55158–55557), production builds, service worker active, profiles in `C:\p62`. Never production, `pos_verify` or another session's services. Rate limits respected: the driver waits out limits (including the 15-minute select-employee window), and the API was never restarted to reset one. Chromium on Windows at 1366×900: **no real device and no physical camera**. No proof-photo flow was exercised (the custom discount type needs no proof), so local Storage wasn't needed.

| Area | Result |
| --- | --- |
| Service worker upgrade and cache isolation | 8 / 8 (§2) |
| Sessions: slow refresh, tabs, transient failures, logout replay, user switch | 10 / 11 (§2) |
| Terminal: cash sale, custom-discount sale, free and paid supplies, **lost sale reply → reload**, **lost paid-supply reply → reload**, database checks | **10 / 10, three times**: idle twice, then under PDF load |
| Cross-role totals (API answers as each role, not read off the screen): expense summary, period summary, payment mix; Supervisor branch switch; Branch blocked from another branch | 5 / 5 |
| Navigation for Admin, Supervisor and Branch | All pages load for each role (§6) |

**Terminal detail.** After a lost sale reply and a reload, the terminal showed "Sale completed — ₱103.00 Cash, change ₱97.00" on its own. The database had exactly one transaction per sale (3), 9 deduction movements (3 recipe lines each, every sale `completed`), exactly one issue per supply operation (3), stock down by exactly the 4 units issued, and ₱15 collected. Earlier terminal runs failed on driver selectors (inline review, the completed dialog after reload) and once on the select-employee limit. None failed on a product defect.

**Not covered in the browser:** real devices and camera, hosted Storage and realtime, offline selling with the network cut (IndexedDB queue and drafts survived identity changes in unit tests; a supply draft visibly survived across driver runs), and on-screen comparison of report totals.

## 9. Fixture and scripts

- `apps/api/scripts/p62-perf-fixtures.ts`: the raw SQL from `42bd3eb` is gone. It uses Prisma `createMany` batches with the same deterministic shape, refuses anything but a local `p62_*` database or an existing P62 dataset, and marks history as already deducted. Ran: about 3 minutes for 55,000 sales. It also adds a no-proof custom discount type and an Extra Supplies card (through its service).
- `apps/api/scripts/dev-local-postgres.ts`: takes `TEST_PG_DB_NAME` and reuses a cluster left by a killed run.

## 10. Failed attempts

- First real-worker runs timed out (worker load counted against render time) → `ready` signal. A fixed 500ms main-thread assertion failed under load → relative bound.
- First integration run of the refresh protocol: replay revocation rolled back; logout exposed the 60s cache; a scripted edit silently didn't apply.
- This batch: a session was cut mid-build and left `next.config.ts` at the old version for the old-SW build; it was restored and checked against HEAD before any other build. A scripted driver edit put a pause in the wrong function, caught by syntax check and review.

## 11. Release blockers and owner decisions

1. **Hosted checks** (§4 checklist): client IP through Vercel → Render; the hosted proxy timeout against the 25s PDF deadline; Render timing.
2. **PDF capacity** (owner): one worker. Rows now fit ~23 a sheet (§12.4), and a refusal answers in about 1s with a Retry-After instead of after 25s (§12.4). Capacity itself is unchanged: a 7-day busy-branch Transaction PDF renders in ~15s locally, so one worker completes about one such PDF per 15s and 3 simultaneous requests still get 1 file and 2 refusals. Options: more concurrency (memory on Render, unmeasured), a shorter default range, or CSV first. No cap was changed.
3. **Extra Supplies rollback** (§5): prohibited with open shifts that have collections; the procedure is written, an owner must accept it.
4. **Requests before session restore** (§6): fixed in §12.1. The "13 Admin calls" were a driver artifact; the real ones (Supervisor 401 and 400) are gone.
5. **Final suites** (§12.6): API run 2 green; run 1's two failures diagnosed and fixed. Web: the `login-form` countdown and `daily-sales-drilldown` failures were test-synchronization defects, fixed in tests (§12.5); full web run 3 green. The P57 hook timeout, the P58 race and the refresh-test 500s did not recur and remain unexplained.
6. Unpushed P59 → P61 owner decisions still apply (their runbooks).

## 12. Readiness batch (local only)

Started at `119e321`. Fresh disposable stack: embedded Postgres `p62_final` on 56441, API 56442, web 56443, task root `C:\p63` (`stack.sh` with `P62_ROOT`, `P62_DB`, `P62_*_PORT`). Same machine and fixture as §6 (55,000 sales; MAIN01 has 1,444 completed sales in the 7-day window). Production builds, service worker active. Nothing hosted was touched.

### 12.1 Requests before session restore

Measured with `request-gate.mjs` (each request's Authorization header as sent, status as received), 3 rounds per account, on the `119e321` build and on the final build (`evidence/browser/request-gate-{before,after,final-supervisor}.json`):

| Per hard reload | Before | After |
| --- | --- | --- |
| Admin | 14 requests, 0 without a token, 0 × 401 | unchanged |
| **Supervisor** | **16 requests: 1 without a token → 401 (`GET /api/branches`), 1 × 400 (`daily-sales` without `branch_id`)** | **14 requests, 0, 0** |
| Branch account, staff (direct login) | 11 / 9 requests, 0, 0 | unchanged |
| Client navigation, all four | 0 without a token, 0 × 401 / 400 | unchanged |

The only remaining non-2xx is staff `GET /api/cash/current` 404 (no open shift), the same in both builds.

**Causes.**
- The "13 unauthenticated Admin calls" in §6 were a measurement artifact. They had no response and no end time, and the new driver reproduces them as the *post-sign-in page's own authenticated requests* (`auth=true`, `net::ERR_ABORTED`), cancelled by the driver navigating again straight after sign-in. On a real hard reload, Admin sends nothing before the refresh.
- Supervisor: React runs child effects before parent ones, so the sidebar `BranchSelector`'s query started before `useAuth`'s restore effect started the refresh. With nothing in flight to wait on, it went out without a token.
- Supervisor `daily-sales` 400: the dashboard month trend fired while the active branch was still unknown, and only a super admin may omit `branch_id`.

**Fix (`483d49e`, `032d07b`).**
- `auth.store` has an explicit `sessionStatus` (`restoring` / `authenticated` / `unauthenticated` / `unconfirmed`).
- `api-client.ts`: a protected request with no token joins, or starts, the one shared refresh and goes out with the resulting token. If the session is over it gets a local `SESSION_EXPIRED`; if it can't be confirmed it gets `SESSION_UNCONFIRMED` (503, still signed in, nothing sent, the next request tries again). After sign-out, nothing is sent at all.
- Public endpoints are never held: login, refresh, reset, 2FA verify, PIN login and the receipt lookup (`isPublicApiPath`, matched to the API routers).
- `useDashboardSalesTrendReport` waits for a branch unless the user is a super admin.
- The branch persisted across a reload is now only a hint. It becomes active once the restored token grants it, and it is cleared on any identity change, so the next account never starts on the previous one's branch.
- Unchanged: server-side authorization, checkout validation, the IndexedDB queues and drafts.
- Tests: `api-client.session-gate.test.ts` (8), `branch.store.test.ts` (5), 4 in `use-reports.test.tsx`. With the gate disabled, 7 of them fail.

### 12.2 Session scenarios (complete set, final web build)

`auth-cache.mjs session`: **12 / 12** (`evidence/browser/auth-session.json`).
- Covered: slow refresh with reloads, three tabs, refresh 503 / 429 / HTML 502 / network failure, logout then cookie replay, user A → B switch with A's requests held, and cache isolation.
- The driver now tags the failures it injects at their source (`x-p62-injected`, aborted requests tracked). They are counted apart from unexpected application failures: **12 injected, 0 unexpected** (no real 429 / 5xx, no page error).
- API log for the run window, sanitized (`auth-session-api-log.json`): 193 requests, 19 × 401, all expected:
  - 1 restore with no cookie
  - 3 replays
  - 1 restore after logout
  - A's 13 held GETs, answered after A's logout with A's revoked token
  - 1 refresh with A's cookie gone

### 12.3 Report totals read off the screens

`report-screens.mjs`: **34 / 34** (`evidence/browser/report-screens*.json`, screenshots). Run again after the terminal driver had made a ₱20-discount sale, so discounts are non-zero.

Setup: MAIN01, 2026-11-15 to 2026-11-21. Each role chose the branch with its own controls (Admin report filter, Supervisor sidebar selector).

| Read from | Matches DB | Shown |
| --- | --- | --- |
| Admin Financial Summary | Gross ₱179,762 · Discounts ₱20 · Refunds ₱2,004 · Net ₱177,738 · Expenses ₱71,006 | ✓ |
| Admin DSR, Expenses, Void/Refund | Completed 1,447 · Voided 15 · Refunded 16 · Expenses ₱71,006 | ✓ |
| Supervisor Reports | Transactions 1,447 · Sales after discounts ₱179,742 · Discounts ₱20 · Voided 15 / ₱1,890 · Refunded 16 / ₱2,004 | ✓ |
| Supervisor and Branch dashboards | Today's gross, transactions, expenses; "Gross Sales — Last 7 Days" (8 calendar days, `manilaDaysAgo(7)`) | ✓ |
| API as Admin, Supervisor, Branch | period summary and DSR sums | ✓ identical |

The database figures were computed independently, with the definitions in `reports.repository.ts`. Admin "Net Sales" (gross − discounts − refunds) and Supervisor "Total Sales" (completed totals after discounts) are different measures under different labels, and each matches its own definition.

The Branch account has no Reports screen: middleware sends it to its dashboard, and Reports is staff-only. Its totals were read from its dashboard. No access was added.

### 12.4 PDF capacity

**Workload definitions** (`pdf-capacity.mjs`, through the web's `/api` rewrite, Supervisor, MAIN01 Transaction PDFs; 1-day ≈ 140 rows, 7-day ≈ 1,444 rows):
- **Sequential:** one person, 3 × 1-day then 3 × 7-day.
- **Realistic:** three people arriving at 0s, 4s and 9s, first with 1-day PDFs, then with 7-day PDFs.
- **Saturation:** the earlier overload test, 4 rounds of 3 simultaneous 7-day PDFs.

An authenticated read (`GET /api/branches/stats`) runs every 500ms throughout. The machine was quiet: about 29% CPU from VS Code, nothing else heavy.

| Workload | Before (`119e321` code) | After (`e8bae36`) |
| --- | --- | --- |
| Sequential | 6/6. 1-day 1.5–1.9s (first, cold 5.8s); 7-day 16.2–17.1s | 6/6. 1-day 1.2–1.7s (cold 3.2s); 7-day 14.9–15.7s |
| Realistic, 1-day | 3/3 | 3/3 |
| Realistic, 7-day | 1/3; both refusals `PDF_TIMEOUT` at 25.0s | 1/3; refused at 0.5s, and at 12.9s when its turn came (never started) |
| Saturation | 4/12 (the earlier session measured 2/12); all 8 refusals at ~25s | 4/12; all 8 refusals `PDF_BUSY` in 0.8–1.2s |
| Reads during load | 0 failed; p95 35–52ms, max 1.4s | 0 failed; p95 33–57ms, max 0.8s |

**Causes measured.**
- Admission existed (1 rendering, 4 queued) but ignored the deadline. A request queued behind a ~17s render waited out the full 25s before being told. A job that started with too little time left was terminated part-way, wasting the only worker.
- **12 rows a sheet:** the cells' unitless `lineHeight: 1.35` was resolved against a font size other than the one the Page passes down.

  | Variant | 240 rows → sheets |
  | --- | --- |
  | Current | 20 |
  | Without `lineHeight` | 10 |
  | Font size set on the cell | 11 |

  The em dash glyph was ruled out: em dash, hyphen and empty all give 20 sheets.

**Fixes.**
- `e52206d`: the font size is set on each cell. 1,436 rows go from 120 sheets to 61, while wrapped text keeps its 1.35 spacing. Render time falls only ~7% (15.2s → 14.0s), because the cost is per row. This is a paper and readability fix, not a capacity fix. Checked as page images (`evidence/browser/transactions-pdf-final-{page-1,last-page}.png`): about 22 rows on sheet 1, the header repeated on each sheet, the last receipt present, "Page 61 of 61".
- `e8bae36`: deadline-aware admission.
  - The pool learns each kind's render milliseconds per serialized input byte from finished renders.
  - An interactive request predicted not to finish before its own deadline is refused at once with `PDF_BUSY`. The `Retry-After` and the message both carry the expected wait: "Try again in about N seconds, choose a shorter date range, or download a CSV."
  - A queued job that can no longer finish is not started.
  - A job too long even for an idle worker gets `PDF_TIMEOUT` at once.
  - Nothing is refused before the first measurement, and a prediction must exceed the deadline by 10% before it counts.
  - The background queue (no deadline) is unchanged, as are the worker count, queue size, 25s deadline and row caps.
- Tests: 6 admission tests (3 fail with the check disabled) and 2 layout tests (600 rows: 50 sheets before, ≤ 27 after; every row and page number present; long values still wrap).

**Under load, final code** (`pdf-capacity-underload-1.json`, `terminal-flows-under-pdf-load-final.json`): the terminal flows ran while saturation PDF load ran continuously.
- Terminal: **10/10**, with the service worker active. Cash sale 693ms, custom-discount sale 503ms, free supply 113ms, paid cash supply 77ms. The lost sale reply and lost paid-supply reply both recovered after reload.
- Database: exactly 3 transactions, 9 deduction movements, 3 issues, stock −4, collections ₱10 + ₱5. One payment or collection and one deduction per operation.
- PDFs that round: **2/12**. 8 refusals in 0.8–3.0s, but **2 admitted renders still reached the 25s deadline** (`PDF_TIMEOUT`). With the browser and terminal running, a render took ~21s against an estimate learned at ~15s. The 10% margin doesn't cover that much slowdown. The estimate adapts (half weight per render), but a sudden load change can still cost a render.
- Reads: 0 failed; p95 255ms, max 2.4s.

**Remaining limits (honest):**
- One worker renders about one busy-branch week every 15s on this laptop. Admission makes refusals fast and clear; it doesn't add capacity.
- Render speed on Render's hardware, its memory for a second worker, and its proxy timeout are unmeasured (§12.8).
- Laptop numbers don't predict hosting.
- The other PDF builders (`pdf.ts`, `expenses-export.ts`, `inventory-summary-export.ts`, `payroll-export.ts`) use the same cell style. The same spacing defect is likely there but was not measured, so it was not changed.

### 12.5 Failures investigated

| Failure | Evidence | Outcome |
| --- | --- | --- |
| **P50R branch discounts** (new, full API run 1): expected the 20% organization default, read 5% | `p50-tax` sets the **global** `discount_policy` employee rate to 5% (line 305) while `p50r` runs in a parallel worker. Both files run together 6 times: **1 failed run** (different assertions, same shared row) | **Fixed** (`440ef2e`): those two files hold a session advisory lock (single-connection client) for their whole run. 6 runs: 0 failed. Nothing else is serialized; no timeout changed |
| PDF route test (run 1) | Pinned `render`'s exact arguments; the deadline is now a 4th | Test updated to assert the deadline too (`5952a62`) |
| BranchSelector tests (web full run 1) | `useBranchStore.getState` missing from the tests' store mock | The hint now comes from `useBranch()` (`032d07b`) |
| P57 shortages hook timeout (earlier) | Passed in both full API runs this batch (7.1s, 9.4s for the file) | **Not reproduced; unexplained** |
| P58 race | `p58-product-types` and `p58r-type-scope-race` passed in both runs | **Not reproduced; unexplained** |
| Refresh-test 500s (earlier) | The same pair, 8 times in one cluster, full logs kept: 8/8 passed, 0 HTTP 500. The full runs contain no real P2028 / P2024 (the 6 hits are mocked tests). Hypothesis, not proven: Prisma's interactive `$transaction` defaults (2s to get a connection, 5s total) in `withAdvisoryLock` under pool contention would give exactly a burst of 500s | **Not reproduced; unexplained** |
| `daily-sales-drilldown` (web, final-code run 2) | 18 failures, starting with a 5s test timeout. Forcing a timeout (`--testTimeout=150`) on the old file reproduced it exactly: tests 1–2 timed out, 3–19 failed in 1–15ms with "Unable to find", the hooks never called. Cause: the receipt-search test ran `await act(async () => advanceTimersByTimeAsync(350))` under fake timers; a test timed out inside that `act` leaves React's act scope open, so no later render in the file commits. The first timeout itself is the cold first mount (~0.6s idle, more under load) | **Fixed (test only):** the search test is synchronous (`act` + `advanceTimersByTime`, only `setTimeout`/`clearTimeout` faked) and now also asserts nothing is sent before the debounce; `afterEach` always restores real timers; one warm-up mount in `beforeAll`. With `--testTimeout=400` the slow tests now fail alone, no cascade. All assertions kept |
| `login-form` "returns to the credentials form when the challenge expires" (web, final-code run) | Showed "0:00" where it expected "0:01". Cause: the TOTP screen renders after `await login()` outside `act`, so React runs the countdown effect (`login-form.tsx:117-131`) as a later task. The test waited only for the "Authentication code" field, which can appear first; `secondsLeft` was still its initial 0 and no interval existed, so `advanceTimersByTime(124_000)` advanced nothing. Reproduced with a 20ms per-render busy-wait: 1 of 3 runs failed | **Fixed (test only):** the test waits for "2:05" (the effect's first value) before moving the clock, as its sibling test already did. 6/6 with the busy-wait, 5/5 without. Optional, not made: start `secondsLeft` from the expiry so "0:00" never flashes |

### 12.6 Suites and checks on the final code

| Check | Result |
| --- | --- |
| Runner failure propagation | A child exiting 7 → runner exit **7** |
| Full API, default parallel, `d5b65e2` (run 1) | **2 failed** (§12.5), 3,843 passed, 5 skipped; runner exit 1 |
| Full API, default parallel, `5952a62` (run 2) | **0 failed**, 3,845 passed, 5 skipped; runner exit 0. API code unchanged after this |
| Full web, default settings, `5952a62` | **2 failed** (BranchSelector mock, §12.5), 1,723 passed |
| Full web, default settings, `032d07b` (final), run 1 | **1 failed** (`login-form` countdown, §12.5), 1,724 passed; exit 1 |
| Full web, `032d07b`, run 2 | **18 failed, all in `daily-sales-drilldown.test.tsx`** (first a 5s test timeout, then the rest of the file cascading), 1,707 passed; exit 1. That file passed in run 1 (11.8s) and twice in isolation (~10s); it uses none of the changed modules. This run took 861s against 598s for run 1 (a busier machine): the §7 class of 5s page-test timeouts under parallel load. Not fixed, no timeout raised. **No fully green full web run on the final code** |
| Shared | 83 passed |
| Typecheck API, web, shared | Clean |
| Lint | 0 errors (API 409 / web 5 warnings, unchanged; shared clean) |
| Production builds | API `tsc` at `e8bae36` code; web `next build` at `032d07b` |
| Browser on final builds | Supervisor gating recheck (§12.1); everything else in §12.1–12.4 ran on builds whose only later change is `032d07b` (BranchSelector reads the same hint another way) |

### 12.7 Rollback checklist (read-only first; nothing executed)

Rule kept: **never roll the API back below P61 while any shift that has Extra Supplies collections is open** (§5).

1. **Read only, every branch.** List open shifts and, for each, Extra Supplies issues with collections. Use a read-only query; check table and column names against `schema.prisma` first. If any open shift has a collection, **stop**.
2. **Read only, every terminal.** On each terminal of each branch: the Extra Supplies Pending tab is empty, no sale shows "checking", and the offline queue (Sync status) is empty. Record each terminal as checked; a terminal that can't be checked blocks the rollback.
3. **Close and drain under current code.** Close every open shift normally, let terminals resolve every pending supply issue and sync every offline sale, then repeat steps 1–2 until both are clean.
4. **Supported targets.**
   - Web rollback is possible to any build that has P62's service worker rules (`next.config.ts` `NetworkOnly` for `/api/`). A build before P62 brings back the `apis` cache (§2, §5).
   - API rollback is possible to P61 or later. P61 → P62 changes no schema.
   - Order: web first, then API.
   - Never drop P61 tables.
5. **After a rollback:** posted stock movements, money, issues and audit rows stay as they are. No balancing entries, no edits to historical amounts. If a shift was closed on pre-P61 code anyway: approve the flagged variance with the reason and issue references (§5).
6. **Roll forward** to current code to restore supply totals in reports.

### 12.8 Hosted checks — NOT RUN (need separate authorization)

Do not add a public debug endpoint, and do not log credentials or session identifiers. Use only Render's and Vercel's own request logs.

1. **Client IP path.** Sign in from two networks at once through the Vercel URL. In Render's logs, compare the address the API records (the rate-limit key) with each network's real address, for both a proxied request and a direct request to the Render URL.
2. **Spoofed headers.** Send a forged `X-Forwarded-For` from a client, both direct and via Vercel. The recorded address must not be the forged one. Send 101 failed logins with rotating forged values from one network: it must get 429.
3. **Budgets not combined.** 101 failed logins from network A must not block login or unauthenticated requests from network B, and two branches behind different networks must not share a budget. If Render sees one Vercel egress address for everyone, decide between `trust proxy` 2 (only if Vercel's forwarded entry is reliable) and different keys. Don't change it on the local two-proxy simulation alone (§4).
4. **Proxy timeout and worker resources.** Time a 7-day busy-branch Transaction PDF through Vercel on staging data. Confirm that `PDF_BUSY` / `PDF_TIMEOUT` arrive as JSON before the hosted proxy's limit, that the 25s deadline suits it, and record Render memory during one render before considering a second worker.

### 12.9 Combined P59–P62 release review (local, against `origin/main` `6931b10`)

Range: 50 commits (P59 12, P60 3, P61 2, P62 32), 299 files. `.vscode/settings.json` is **not** in the range.

**Migrations (3, all additive; apply before the API):**
- `20261104120000_pos_perf_p60_expense_types`: new tables; `expenses.expense_type_id` / `expense_type_name` nullable; FK and CHECK added `NOT VALID`; `expense_idempotency_keys.request_hash` nullable.
- `20261104120100_pos_perf_p60_validate_expense_type_fk`: validates both, in its own transaction.
- `20261105120000_pos_perf_p61_extra_supplies`: new tables only.
- No drops, renames, type changes or data updates. The two removed `schema.prisma` lines are realigned relations. P62 has no migration.

**Order:** migrations → API → web. P60/P61 need the API before the web; the P59 overlap shows "Unspecified discount"/several "Manual" rows until both are updated; P62 works in either order (§5).

**PDF:** typed JSON errors (`PDF_BUSY` 503 + Retry-After, `PDF_TIMEOUT` 503 + Retry-After, `PDF_TOO_LARGE` 413, `PDF_FAILED` 500); worker crash/exit/hang ends in `PDF_FAILED`/`PDF_TIMEOUT`, never a stuck request. The Transaction PDF caps at `TRANSACTION_PDF_MAX_ROWS` = 2,000; one worker, so capacity stays an owner decision (§11.2).

**Local blockers:** none open in code or suites. Remaining are owner decisions: PDF capacity (§11.2), Extra Supplies rollback procedure (§12.7), P59 VAT/receipt decisions, P60 expense-type setup before rollout. Still unexplained but not recurring: P57 hook timeout, P58 race, refresh-test 500s (§12.5).

**Hosted-only, NOT RUN:** §12.8 (client IP path, spoofed headers, separate budgets, proxy timeout and Render memory), real devices/camera/printing, hosted Storage and realtime, mixed old/new versions in hosting, rollback rehearsal on hosted data.
