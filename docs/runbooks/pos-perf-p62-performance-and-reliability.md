# POS-PERF-P62 — Performance and reliability

Branch `feat/pos-perf-p62-performance-and-reliability`, local only: not pushed, no PR, nothing deployed, production not accessed.

**Not release-ready.** Authentication, cache isolation and PDF blocking are fixed and tested at the code level, but the browser checks, navigation measurements, end-to-end checkout-under-load timing and rollback rehearsal were **not done** (§9), and the default test suites still fail (§7).

## 0. SHAs and dependencies

| | SHA |
| --- | --- |
| Started from | `42bd3eb` ("TASK TRACKER": untested PDF worker code plus an accidental `.vscode/settings.json` change), parent `fa31ede` (P61 docs) |
| Settings correction | `1be724e` |
| Auth fix | `8a4fc17` · Rate limit `f3e16ad` · PDF tests and start-up timer `6151684` · Worker temp env `abd2cc2` |
| Web auth and cache isolation | `4febdd6` · Service worker `6fd5f8d` |
| Test fixes | `780c5b1` (test files only) · Lint `a0be182` (`.mjs` headers only) |
| Full API suite run on | `6fd5f8d` |
| Full web suite run on | `780c5b1` |
| Builds, PDF benchmark, PDF visual check | `a0be182` |

P62 sits on unpushed P61 → P60 → P59 (see their runbooks). Merging P62 brings all of them in.

**Settings:** `42bd3eb` committed a personal editor setting. `1be724e` restores the tracked file to `fa31ede`; the owner's copy is left modified and unstaged. `git diff fa31ede HEAD -- .vscode/settings.json` is empty.

## 1. Authentication: causes and rules

Each cause was reproduced by a test that failed on the old code path. Tests: `API/auth/p62-refresh-protocol.integration.test.ts` (real Postgres and HTTP), `API/auth/auth.service.test.ts`, `WEB/lib/api-client.test.ts`.

| Cause found | Fix |
| --- | --- |
| The rotation cache was read **before** the presented token, so a rotated token collected its successor from another device, after expiry, or after the session was revoked | Every check runs first: the token exists, is unexpired, is on this device, and its user is active and operational |
| The 10s cache window started at the transaction's start (Postgres `now()`), so waiting on the lock shortened it. This plausibly explains the P61 run 9 sign-out | `createdAt` set explicitly; window is `ROTATION_GRACE_MS` = 30s |
| Logout revoked only the cookie's token. After a lost refresh response the cookie holds the rotated token, so the live successor survived | Logout revokes every live token of that user on that device |
| A logged-out access token stayed accepted for up to 60s from `verify-access-token.ts`'s in-process "not revoked" cache | Revocation evicts the entry (`forgetNotRevoked`) |
| A real replay only logged; the successor chain stayed usable | Replay revokes the device session. The revocation is **returned, then thrown**, because a throw inside the transaction rolled it back (found by the test) |
| The cache stored the plaintext access and refresh tokens for up to 1h | It stores only the successor, encrypted (`encryptField`); a replay gets a newly signed access token. Rows are pruned after 30s, hourly |
| Web: any refresh failure (network, 429, 5xx, gateway HTML) signed the user out | Only `REFRESH_INVALID`/`REFRESH_MISSING` (401) and `ACCOUNT_INACTIVE`/`BRANCH_INACTIVE`/`BRANCH_ASSIGNMENT_REMOVED` (403) sign out. Anything else returns 503 `SESSION_UNCONFIRMED`; the user stays signed in and the original request was not processed |
| Web: every 401 was treated as an expired token, so a wrong PIN or password was refreshed and **sent again** | Refresh only on `TOKEN_EXPIRED/INVALID/MISSING/REVOKED` (or a non-JSON 401). Other 401s go straight back to the caller |

**Protocol (`authService.refreshToken`).** One advisory lock per device session (user + device) covers refresh, replay revocation and logout. A presented token that was rotated gets its successor back only if all of these hold:

- the request comes from the same device;
- the successor is unused, unexpired and unrevoked;
- the cache row is under 30s old;
- the user is still active and operational.

Anything else from a rotated token is a replay, and the device session is revoked.

**Why 30s, and why it can't be abused.** The client abandons a refresh after 15s (`REFRESH_TIMEOUT_MS`). The web middleware's two 8s attempts finish within about 16.3s. 30s is about twice the longest wait before the old token comes back.

Holding a rotated token for those 30s grants nothing beyond what the same token granted moments earlier, and only while the legitimate client hasn't used the successor yet. After that, any reuse revokes the session, including the attacker's copy.

Cases the integration test refuses:

- another device;
- an expired token;
- a deactivated user;
- a session revoked by logout or revoke-all;
- a successor that was already used;
- a token presented after the 30s.

**Tabs.** The web refresh runs under a Web Lock (`pc-auth-refresh`), so tabs take turns and the second tab sends the cookie the first one's answer set. Without Web Locks, the server lock and grace period still keep concurrent tabs signed in. Integration test: 6 concurrent refreshes of one token all get the same successor, and one live token remains.

**Refresh tokens stay in the HttpOnly cookie**, never in localStorage.

## 2. Cross-user cache isolation

- **Query cache.** `auth.store` has `identityEpoch`. It goes up on sign-out or when a different user signs in, but not on a reload restore or a same-user refresh. `useIdentityScopedQueryCache` (in `Providers`) then cancels every query and clears the cache.
- **In-flight responses.** `fetchAuthenticated` drops any response that started under an earlier epoch and returns `IDENTITY_CHANGED`. That message tells the cashier to check Receipts or History, because a sale or supply issue may have been recorded.
- **IndexedDB is left alone.** Offline sales queue, drafts and unresolved operations (Dexie) stay recoverable and keep their attribution.
- **Service worker.** next-pwa's default `apis` rule cached every same-origin `GET /api/*` for 24h, keyed by URL only, and served it when the network was slow (over 10s) or offline. `next.config.ts` replaces it with a `NetworkOnly` rule under the same cache name. Verified in the built `public/sw.js`: the `apis` NetworkFirst rule is gone, and the `/api/*` NetworkOnly route is registered before every caching rule. The terminal's offline catalogue uses the Dexie snapshot (`lib/offline/cache.ts`), not the SW cache.
- **Upgrade.** `purgeApiResponseCache` deletes the `apis` cache and any stored `/api/` response from every cache, at start-up and on each identity change. Precache and static assets are kept. The new SW activates at once (next-pwa defaults `skipWaiting`/`clientsClaim`). Until a browser has loaded the new build, its old SW can still answer from `apis`. **Not verified in a real browser** (§9).

Tests: `WEB/hooks/use-identity-scoped-query-cache.test.ts` (A → logout → B with a fetch in flight; restore and same-user refresh keep the cache; purge deletes only API entries), `WEB/lib/api-client.test.ts` (identity change mid-request).

## 3. PDF isolation

Every PDF (report, transactions, expenses, inventory summary, payroll, and the background report queue) renders in a worker thread (`lib/reports/pdf-render-pool.ts`, `pdf-render.worker.ts`). No synchronous fallback exists. Routes keep authorization and scoped database reads; the worker receives rows and labels only.

| Bound | Default |
| --- | --- |
| Workers rendering at once | 1 |
| Queued | 4; beyond that `PDF_BUSY` (503, Retry-After 60) |
| Queue wait | 60s, then `PDF_BUSY` |
| Render time | 120s from the worker being ready, then `PDF_TIMEOUT` (503) and the thread is terminated |
| Worker start-up | 60s to load the renderer, then `PDF_FAILED` |
| Input / output | 32 MB / 64 MB, `PDF_TOO_LARGE` (413) |
| Worker heap | 512 MB; jobs per worker 25; idle worker ends after 60s |
| Client leaves | Render cancelled (`cancelPdfWhenClientLeaves`) |
| Shutdown | Queued jobs refused, running ones terminated (`server.ts`) |

- **Environment.** The worker gets `NODE_ENV`, `TZ`, and the OS temp locations `TEMP`, `TMP`, `TMPDIR` and `SystemRoot`. Without those, Windows wrote tsx's cache to `apps/api/undefined/` (found, fixed in `abd2cc2`, directory removed). No configuration or credentials reach the worker, which the test checks with a canary variable.
- **Start-up timer.** Before P62's fix, the render timeout included loading react-pdf, which takes about 10s under tsx here. The worker now signals `ready` and the render timer starts from then.
- **Transaction PDF.** Above 100 rows it is split into sheets of 24 rows instead of one Page holding everything.
- **Packaging.** `tsc` emits `dist/lib/reports/pdf-render.worker.js` next to the pool. The benchmark ran it from `dist/` with plain Node, no tsx. Test fixtures are not shipped.

**Measured on the production build** (`docs/runbooks/pos-perf-p62-evidence/pdf-render-benchmark.json`, `a0be182`, clean tree, Node v24.18.0). The machine was a Pentium Gold 7505 (4 threads, 8 GB) **at 100% CPU from other processes (VS Code) throughout**, so absolute times are inflated. Three repetitions per row count; the "stall" is the worst gap of a 10ms event-loop timer.

| Rows | Request thread (old): total / stall | Worker (P62): total / stall |
| --- | --- | --- |
| 100 | 4.0–7.0s / **2.9–5.8s** | 5.1–7.2s / **25–161ms** |
| 300 | 6.6–8.1s / **5.0–5.6s** | 6.8–7.9s / **80–110ms** |

Cold first job (worker start plus a 1-row PDF): 5.3s, stall 246ms. Builder import on the main thread: 10.1s.

**Baseline comparison method.** The "request thread" rows call the same renderer in the same process. That is exactly what `fa31ede` did on the request path. Any request arriving during the stall, checkout and `/health` included, waits for it. An HTTP checkout-under-PDF-load benchmark was **not** run (§9).

**Visual check.** PDFs were rendered by the production worker and rasterised with PyMuPDF (scratch tool, not a project dependency). For a 130-row Transaction PDF, sheets 1, 2 and 18 were inspected as images: header, scope and filter labels, repeated column header, money values, the voided row, and "Page n of 18". The last row (130) is present. The empty export shows the "No transactions match" state.

**Layout finding, not changed.** Narrow columns wrap (for example "SM North / EDSA") and wrapped cells get a very large line gap, so about 8 rows fit per sheet and 130 rows take 18 sheets. The cell styles predate P62.

**Limits that remain.**

- Rendering cost is about 20–70ms per row here, so a 2,000-row Transaction PDF (the route's cap) can exceed the 120s render timeout on slow hardware. It is refused cleanly (`PDF_TIMEOUT`) without blocking anyone, but the user gets no file. Owner decision: lower the cap, or offer CSV.
- With concurrency 1, two branches exporting at once wait in turn.
- Hosted Render timing is unknown.

## 4. Rate limits

| Limiter | Before | After |
| --- | --- | --- |
| `apiLimiter` (global, runs before authentication) | Keyed on `req.user`, which was never set, so **always per IP**, 100/min | Verified RS256, unexpired bearer: per user, 300/min. Anything else (no token, forged, `alg:none`, expired, malformed): per IP, 100/min unchanged |
| Login, PIN, 2FA, reset, receipt lookup, select-employee | Unchanged | Unchanged, applied on top |

- **Spoofing.** No client header is trusted: `X-Device-ID`, `X-User-ID` and `X-Forwarded-For` are tested. `req.ip` comes from `trust proxy 1`.
- **Branch terminals.** All terminals signed in to one branch account share that account's 300/min.
- **Per instance.** Counters live in each process's memory, so N API instances allow N times the limit.
- **Unverified hosted assumption.** Browsers reach Render through Vercel's `/api` rewrite and then Render's proxy. With `trust proxy 1`, `req.ip` may be Vercel's egress address rather than the user's. Unauthenticated traffic, login included, could then share buckets across branches. Authenticated traffic no longer depends on IP. Check on staging before release.
- **Tests** (`API/middleware/rate-limiter.test.ts`): several users behind one IP, one abusive session across IPs, forged and expired tokens and spoofed headers, unauthenticated traffic, and the login limiter still in force.

## 5. Rollout and rollback

**Schema:** no migration. **Order:** API, then web (independent; either order works).

**Mixed versions and rollback, reasoned (not run, §9):**

| Situation | Effect |
| --- | --- |
| New API, rotation-cache rows written by the old API | Rows older than 30s are ignored. A plaintext row inside its window fails to decrypt and is refused (401), so at most one sign-out per session that was mid-refresh at deploy time |
| Roll the API back to pre-P62 | The old code returns the encrypted cache value as a cookie for up to 10s, so a session mid-refresh is signed out once. Old code also brings back every §1 defect |
| New web, old API | The web's stricter 401 handling and SW change don't depend on the API |
| Roll the web back | The old SW's `apis` cache returns. Purge cannot run without the new page code |

**Extra Supplies rollback (P61) was not rehearsed** (§9). P61 runbook §7 still applies: a shift open during a rollback would lose cash supply collections from expected cash.

## 6. Performance: what was and wasn't measured

Measured:

- PDF event-loop stall, request thread vs worker, on the production build (§3);
- worker cold start;
- the 600-row worker render inside the test suite: 18.1s with a 74ms worst main-thread gap alone, 79.6–86.0s with a 650–698ms worst gap while other files ran.

**Not measured:**

- Admin, Supervisor and Branch navigation (first useful data, request counts, waterfalls);
- cold vs warm navigation;
- HTTP checkout and paid Extra Supplies latency, idle vs under PDF load and saturation;
- any hosted timing.

The fixture script from `42bd3eb` (`apps/api/scripts/p62-perf-fixtures.ts`) was **not run and is untested**. It uses raw SQL inserts, which `.claude/CLAUDE.md` forbids for application code; decide before relying on it. No navigation or query bottleneck was demonstrated, so none was changed.

The lost raw results from the earlier session are not evidence. Their "about 300s" claims were removed from code comments in favour of the numbers above.

## 7. Test results

All runs used a fresh embedded Postgres (`scripts/with-test-postgres.ts`), sequential, with no other heavy job running. The environment held throwaway keys and placeholder services, built from `.env.example` the way CI does; nothing was written to `apps/api/.env`. `with-test-postgres.ts` exits 0 even when vitest fails, so every result below is read from vitest's own summary.

| Check | Result |
| --- | --- |
| Full API suite, default parallel, `6fd5f8d` | **9 failed**, 3,796 passed, 15 skipped (1,241s) |
| Of those, my test bug | 5 in `p62-pdf-routes` (422: the export hit the 2,000-row cap with the full suite's data). Fixed in `780c5b1`; passes in the rerun |
| Of those, cold PDF worker under load | P40 transaction PDF and payroll integration (20s timeouts). Given a stated 90s per-test allowance in `780c5b1`; both pass in the rerun |
| Of those, load or unproven | `payroll-export` multi-page (60s timeout, renders on the test thread; passes in 35.2s when given longer, so slow and not hung, **still failing at its own 60s**); `P58` race (`PRODUCT_TYPE_NOT_FOUND` vs `INACTIVE`); `P61` "history and reports" hook timeout (10s). Not changed |
| Rerun of the failing files plus `flavors`, `780c5b1` | 1 failed (`payroll-export` multi-page), 121 passed, 10 skipped; `P61` hook timed out again |
| `flavors` | **Did not fail** in either run, so not reproduced. Unproven hypothesis: `createFlavor` provisions ingredient rows for every branch in the database while other files create and delete branches. Not changed |
| Full API suite after `780c5b1` | **Not re-run** |
| Full web suite, normal 5s timeout, `780c5b1` | **10 failed**, 1,697 passed (1,387s). All "Test timed out in 5000ms" in files P62 doesn't touch (terminal page, checkout workspace, inventory, products, manual discounts). Not fixed; no timeout changed |
| Shared suite | 83 passed |
| Typecheck API, web | Clean |
| Lint | API 0 errors (405 warnings, 2 of them P62 `no-console`); web 0 errors, 5 warnings |
| Production builds | API `tsc` clean; web `next build` exit 0 (Sentry configuration warnings only) |
| Migration rehearsal | Not needed: no schema change |

**Unexplained local flake.** Some web runs failed every React-rendering test that uses the real auth store with "Cannot read properties of null (reading 'useEffect')": `use-auth` 15/15, `use-socket` 4/4 and `terminal/page` 171/171. Once triggered, it persisted across separate vitest processes. It cleared when the source files were rewritten (`git checkout` and copy back), with byte-identical content. HEAD code passed the same combinations in the clean state, and so did the final code (56/56 twice). No disk cache was found (`node_modules/.vite` holds only `results.json`). It did not appear in the full web suite run.

## 8. Failed attempts

Recorded so they aren't repeated:

- **First real-worker test runs** timed out (worker loading react-pdf for about 10s under tsx, counted against the render timer). That led to the `ready` signal.
- **A fixed 500ms main-thread-gap assertion** failed at 698ms under machine load. The test now asserts the gap is under a tenth of the render time (and under 2s), and logs both.
- **First integration run of the refresh protocol:**
  - the replay revocation rolled back (throw inside the transaction);
  - the logout case exposed the 60s not-revoked cache;
  - a scripted edit to `blacklistToken` silently didn't apply and was caught by the test.
- **A rendering version of the identity test** was replaced by one driving a real `QueryClient` without React while chasing the flake in §7. The flake turned out not to depend on it.

## 9. Not done

- **Browser checks with the service worker active:**
  - reload and refresh during a slow response;
  - user switch;
  - role navigation and branch switching;
  - no-discount and custom-discount checkout;
  - free and paid supplies with lost-response recovery;
  - expense and report totals;
  - PDF concurrent with checkout;
  - SW upgrade from a build with a populated `apis` cache.
- Navigation and request-count measurements (§6).
- HTTP checkout and paid-supplies latency under PDF load and saturation, with one-deduction verification.
- **Extra Supplies rollback rehearsal on older code.** It needs a checkout of pre-P61 code in this working tree, and it was not done.
- Root cause of the `flavors`, P58 and P61 parallel failures, and of the web 5s timeouts.
- Real devices, hosted Render and Vercel, proxy IP behaviour.

## 10. Other findings, not changed

- `/api/auth/logout` requires a valid access token. With an expired one the client refreshes first. If that refresh is unavailable, the client clears itself but the server session stays live until the refresh token expires.
- After logout, other tabs' access tokens stay valid server-side for up to 15 minutes (only the logging-out tab's token is blacklisted); the cross-tab broadcast clears them client-side.
- The Next middleware treats any 401 from the refresh endpoint as a dead session. The client treats only the listed codes as final.
- An orphaned embedded-postgres `io_worker` process (started 10:31 PM on Nov 20, parent gone) was seen. It can't be proven to belong to this session, so it was left alone.
