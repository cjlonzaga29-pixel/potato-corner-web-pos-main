# POS-PERF-P62 — Performance and reliability

Branch `feat/pos-perf-p62-performance-and-reliability`, local only: not pushed, no PR, nothing deployed, production not accessed.

**Not release-ready.** The code-level work is done and was verified in a real browser on a local stack, including the business flows. It found and fixed four more product defects (§1, §2, §3) and the test-environment causes in §7. What still blocks a combined release is in §11: hosted-only checks, owner decisions on PDF capacity and Extra Supplies rollback, a request burst before session restore that predates P62, and the full-suite results in §7.

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
2. **PDF capacity** (owner): one worker, 12 rows per sheet. A 7-day busy-branch Transaction PDF takes ~20s; under sustained demand 2 of 12 succeeded. Options: denser rows (layout change), more concurrency (memory on Render), a shorter default range, or CSV first. No cap was changed.
3. **Extra Supplies rollback** (§5): prohibited with open shifts that have collections; the procedure is written, an owner must accept it.
4. **Requests before session restore** (§6): spends the shared per-IP budget on every reload; predates P62; not fixed.
5. **Final suites** (§7): web green. API green on one of two final runs; the other had an unexplained P57 hook timeout. The P58 race and the one-off refresh-test 500s were not reproduced and remain unexplained.
6. Unpushed P59 → P61 owner decisions still apply (their runbooks).
