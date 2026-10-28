# POS-PERF-P44 — Pilot verification and safe E2E setup

Starting local HEAD: `8999e5cb6d1d277a94294dafe003594676981995` (P43R2 cutover evidence, docs only, unpushed).
`origin/main` = production: `abee6020a3cd4d50c4b24e3b2887c2c64b31d62f`. After `git fetch`: no drift, `origin/main`
is an ancestor of HEAD, HEAD is 1 ahead and 0 behind. The unpushed `8999e5c` is preserved.

This change is local only:

- Nothing was pushed, dispatched or deployed.
- No account, branch, PIN or GitHub secret was created in production. No credential was read, rotated or printed.
- This task sent **no request to production**. Every run below targeted `127.0.0.1`.
- No POS, API or web application code changed. The changes are to tests, test configs, two workflow steps, and this runbook.

Clock-in, PIN entry and the staff POS flow already exist (P26–P41). Nothing was rebuilt from stale roadmap wording.

## 1. What the production smoke actually did before P44

`deploy-production.yml` runs **one** suite after the web promote is verified:
`pnpm exec playwright test --config=tests/e2e/playwright.pilot.config.ts`. It sets `PLAYWRIGHT_BASE_URL` to
`https://www.potatorenovare.com` and passes six secrets. It skips with a notice when `E2E_SUPER_ADMIN_EMAIL` is
unset, which is what happened on every run so far (P43 §11.5 step 9). So no production smoke has ever run.

Reading the code, not the comments, found these problems:

| # | Finding | Effect if the secrets had been set |
| --- | --- | --- |
| 1 | `pilot-smoke.spec.ts` expected admin nav links `Products`, `Recipes`, `Employees`. P40 removed or renamed them. | 2 of 5 tests fail on every deploy. |
| 2 | It logged in a password-based `staff` user (`E2E_STAFF_*`). Since Branch Employee Authorization, `staff` rows have no email or password (`auth.service.ts`), and cashiers sign in with a PIN on a `branch` session. | That test cannot pass in production. The only way to "fix" it would have been to give a cashier a password. |
| 3 | The invalid-login test used the **real staff email** with a wrong password. | Each deploy adds 1 to that account's `login_attempts` (lockout at 5, `auth.repository.ts`) and writes a `LOGIN_FAILURE` audit row naming it. |
| 4 | Realtime was not blocked. When the last socket in a branch room disconnects, `socket/presence.ts` queues a real `branch_offline` notification 30 s later (and `branch_online` on the next join). The in-memory "already offline" set is empty after every API restart, i.e. right after a deploy. | A supervisor or branch smoke login after a deploy could notify admins that a real branch went offline. |
| 5 | Configs defaulted `PLAYWRIGHT_BASE_URL` to production (`pilot`, `production`, `production-smoke`, `p3-verify`, and the k6 load script). | An unset variable meant "run against production". |
| 6 | `expenses.production.spec.ts`, in `playwright.production.config.ts`, **created, edited and deleted real expenses and uploaded a receipt image to production Storage**. It also hardcoded the production URL. | Business data and Storage writes in production on every run of that config. |
| 7 | `branch-selector.production.spec.ts` hardcoded the production URL for its API context. | It ignored `PLAYWRIGHT_BASE_URL`. |
| 8 | The shared mutating `playwright.config.ts` had no ignore rule, so it also collected every `*.production.spec.ts`. Its `global-setup.ts` fell back to `localhost`, but nothing refused a production `PLAYWRIGHT_BASE_URL`. | `PLAYWRIGHT_BASE_URL=https://…potatorenovare.com npm run test:e2e` would have run sales, voids, clock-ins and seeding against production. |
| 9 | Six fixture scripts open their own `PrismaClient` and write rows directly, with no target check: `p37-branch-stock`, `p38-branch-setup`, `p38r-single-publish`, `p39r2-audit-history`, `seed-legacy-movement`, `seed-shared-branch-product`. Only `p40-admin-fixtures` refused a non-local URL. | They write to whatever `apps/api/.env` points at. |

## 2. Scenario matrix (every suite, as it now stands)

"Isolated" means the shared `playwright.config.ts`: seeded local accounts, local or confirmed-isolated target only (§4).

| Category | Suites | What they write | Where they may run |
| --- | --- | --- | --- |
| Read-only navigation | `pilot-smoke` (the deploy gate); `production-smoke`; `branch-selector`, `notifications-page`, `payments-gcash-qr`, `inventory-analytics-page`, `active-sessions`, `two-factor` `.production`; `p3-fixes-verification`; `dashboard-live-activity`/`settings-page` `.production` (not matched by any config, unchanged) | Nothing except sign-in/out, enforced by the read-only guard | Production (dedicated accounts) or local |
| Authentication / session writes | All of the above sign in. `auth`, `login-audit`, `pos-perf-p30r-session-security` exercise lockout, sessions and revocation | Session rows, `LOGIN_SUCCESS`/`LOGOUT` audit rows, revoked-token rows, `last_login_at`; lockout counters (isolated suites only) | Smoke: production. Lockout/revocation suites: isolated |
| Account provisioning | `branch-accounts`; `pos-perf-p36r6`, `p37`, `p38`, `p38r`, `p38r3`, `p39`, `p39r2` (create employees, `change-password`) | New users, password changes | Isolated |
| Attendance / clock-in, PIN | `attendance`, `staff-pin-inventory-ops`, `pos-perf-p30r*`, `p36r`, `p36r6`, `p37`, `p38` | Clock-in/out rows, PIN verification, employee sessions | Isolated |
| Product / inventory writes | `inventory`, `inventory-approval-cancellation`, `pos-perf-p31r`, `p36r`, `p36r2`, `p37`, `p38*`, `p39*`; fixtures `seed-catalog`, `seed-ingredient`, `seed-universal-item`, the six direct-Prisma scripts | Global products, options, universal items/categories/units, per-branch stock; **the global `/api/settings/write-gate`** (p38) | Isolated (direct-Prisma scripts: local DB only) |
| Sales / refunds / voids, cash | `pos-workflow` (incl. hold), `void-transaction`, `discount-audit`, `cash-management`, `branch-management`, `offline-sync`, `pos-perf-p30r2`, `p36r`, `p36r6`, `p37`, `p38` | Transactions, voids, holds, cash sessions, inventory deductions | Isolated |
| Uploads / downloads | `expenses` (receipt upload, CSV export), `pos-perf-p30r5` (adjustment proof), `p40`, `p40r2` (proof photos via Storage, PDF/CSV downloads) | Storage objects, generated files | Isolated (p40 fixtures: local Storage only) |
| Cleanup / deletion | `expenses` (API DELETE), `p40` fixture `cleanup`, p38/p39 fixtures | Deletes | Isolated |
| Load | `tests/load/pilot-smoke.k6.js` | Logins and token refresh at volume; reads | Owner decision only; now requires an explicit target |

## 3. What P44 changed

| File | Change |
| --- | --- |
| `tests/e2e/helpers/e2e-target.ts` (new) | The one place that decides targets. `resolveProductionSmokeBaseURL`: no default; only `https://potatorenovare.com`, `https://www.potatorenovare.com` or a local origin. `resolveIsolatedBaseURL`: defaults to `http://localhost:3000`; refuses `potatorenovare.com` and every subdomain, even if "confirmed"; any other non-local host only when `E2E_ISOLATED_REMOTE_HOST` names it exactly. |
| `tests/e2e/helpers/read-only-guard.ts` (new) | Routes every browser request. Aborts anything but GET/HEAD/OPTIONS except `POST /api/auth/login`, `/refresh`, `/logout`, and fails the test, listing what it blocked. Blocks Socket.io (HTTP and WebSocket) unless a Super Admin–only spec opts in. Configs set `serviceWorkers: 'block'` so no request escapes the routing. |
| `tests/e2e/pilot-smoke.spec.ts` | Rewritten as the production-safe smoke (§4.1). Uses `E2E_BRANCH_*` instead of `E2E_STAFF_*`. Ignores exactly two page errors: the one the harness causes by blocking the service worker, and the known `swe-worker` defect (§6.3) only while it is the sole script served as HTML. |
| `playwright.pilot` / `production` / `production-smoke` / `p3-verify` configs | Base URL from `resolveProductionSmokeBaseURL`. `serviceWorkers: 'block'`. The production config no longer matches the expenses suite. |
| `helpers/prod-login.ts`, `global-setup.production.ts` | Guarded contexts (realtime allowed: Super Admin only). No production fallback. Removed a pre-existing type error (`extend<Record<string, never>>`). |
| `production-smoke.spec.ts`, `p3-fixes-verification.spec.ts`, `branch-selector.production.spec.ts` | Use the guard and the resolver instead of hardcoded production URLs. |
| `expenses.production.spec.ts` → `expenses.spec.ts` | Moved to the isolated suite: seeded local Super Admin, `resolveIsolatedBaseURL`. |
| `playwright.config.ts`, `global-setup.ts` | Isolated resolver in both; production-credential specs are never collected. |
| `fixtures/local-db-guard.cjs` (new) + six direct-Prisma scripts | Load `apps/api/.env` the way Prisma does (process env wins), then refuse unless `DATABASE_URL`, `DIRECT_URL` and `SUPABASE_URL` are local. Errors name the variable, never the value. |
| `tests/e2e/helpers/guards.node-test.mts` (new), `ci.yml` | 8 unit tests for the guards, run by a new "E2E guard tests" step (Node test runner, no network, no secrets). |
| `deploy-production.yml` | Smoke step passes `E2E_BRANCH_EMAIL`/`E2E_BRANCH_PASSWORD` instead of `E2E_STAFF_*`. Nothing else in the job changed. |
| `tests/e2e/.env.e2e.example`, `tests/load/pilot-smoke.k6.js` | No production default. Branch account instead of staff. |

## 4. Boundaries

### 4.1 Production-safe smoke (what the deploy runs)

`pilot-smoke.spec.ts`, Desktop Chrome, one worker, no retries, no trace/screenshot/video, `preserveOutput: 'never'`, list reporter:

1. **Deployment readiness:** `GET /api/health` returns `{status:'ok'}`; `/login` is 200 and renders. (API rollout and web alias are
   already proved by the P43 `render-verify`/`vercel-verify` steps before this runs.)
2. **Super Admin:** sign in → Super Admin Dashboard → Branches, Supervisors, Attendance Monitoring, Reports, System Settings each
   render with no error boundary and no uncaught page error → sign out.
3. **Supervisor:** sign in → Supervisor Dashboard → Products resolves to the product list or its empty state (no stuck
   loading list) → `/admin/dashboard` is refused (redirected back to `/supervisor/…`) → sign out.
4. **Branch:** sign in → Branch Dashboard → `/branch/terminal` shows **Open POS Terminal · Terminal Locked** and no product catalog.
   **No PIN is entered, so nobody is clocked in.** `/admin/…`, `/supervisor/…` and the staff-only `/branch/employees` are refused →
   sign out.
5. **Signed-out** `/admin/dashboard` goes to `/login`.
6. **Invalid login** uses `e2e-smoke-no-such-account@pilot-smoke.invalid` (RFC 2606 `.invalid`). No account's lockout counter moves
   and no audit row names a user (unknown email returns before any write).

**Honest footprint per run (production):** 3 successful sign-ins → 3 refresh-token rows (rotated on page loads, revoked at
sign-out), 3 `LOGIN_SUCCESS` and 3 `LOGOUT` audit rows (the branch account's `LOGIN_SUCCESS` carries the pilot branch id, so it
appears in that branch's activity log), 3 `last_login_at` updates, 3 revoked-access-token rows written at sign-out, and 4
login-limiter hits (each sign-in has its own device id; limit 10 per 15 min per IP+device).

Reads also write, **server-side**, and no browser guard can stop that: dashboard report endpoints record a `REPORT_ACCESSED`
audit row per report read (DAILY_SALES, PAYMENT_METHOD_MIX, PRODUCT_PERFORMANCE, INVENTORY_CONSUMPTION_SUMMARY, …) and may
upsert a `report_snapshots` cache row; the first visit to Settings creates a default `notification_preferences` row for the
Super Admin account. These are audit/cache/default rows, not business data.

**Measured on the disposable stack (one full smoke run, before/after row diff over every table):** `LOGIN_SUCCESS` +3,
`LOGOUT` +3, `REPORT_ACCESSED` +19, `refresh_tokens` +7, `revoked_tokens` +3, `refresh_token_rotation_cache` +4. Nothing else
changed. No `login_attempts` moved, and `notifications` stayed at 0 even 35 s after the run (past the 30 s presence debounce).
Any other write is aborted by the guard and fails the run.

**Credential policy:** *superseded by POS-PERF-P44R* (`pos-perf-p44r-worker-routing-and-smoke-guards.md` §3). The run/skip
decision is now made before any production write over all six secrets, and each address must contain `e2e-smoke`. No
`PLAYWRIGHT_BASE_URL`, or one that is not an approved production or local origin → the config refuses to load (unchanged).

### 4.2 Isolated mutating E2E

Everything else in §2. It runs only where `resolveIsolatedBaseURL` allows, and its direct-database fixtures only against a local DB.

**Why not a "test branch" in production.** The system cannot isolate one:

- Products, product options, universal inventory items/categories/units and units of measure are **global**; the suites create
  them, and a supervisor would see them in Catalog Setup.
- `pos-perf-p38*` toggles the **global** `/api/settings/write-gate`.
- Super Admin dashboards and reports aggregate **all** branches; notifications dual-emit to the Super Admin room; branch
  online/offline notifications fire for any branch.
- Sales feed shift/cash reconciliation, inventory deductions, the nightly fraud scan and EOD summary jobs.

So mutating E2E needs a **separate environment**: its own database, Storage, API and web. Today that is local disposable
infrastructure (§6). A shared remote test environment does not exist; `deploy-staging.yml` is unchanged and still has no smoke.

## 5. Dedicated accounts and secrets

### 5.1 Minimum accounts

| Account | Why it is needed | Scope |
| --- | --- | --- |
| Super Admin | `/admin/*` is reachable only by `super_admin` | Sees everything by role. Protection is the read-only guard, not scope. |
| Supervisor | Supervisor dashboard and product catalog are `supervisor`-only | Assigned to the pilot branch only |
| Branch | The POS terminal lock screen and branch dashboard need a `branch` session | A **second** branch account on the pilot branch |

No `staff` account: cashiers have no password, and the smoke never enters a PIN. No dedicated test branch: a fake branch would
appear in every branch list, report, picker and publication target. The rehearsal (§6.2) confirmed a branch can have a second
`branch` account.

### 5.2 Exact secret names

In the GitHub **`production` environment** (the `deploy-production` job runs with `environment: production`, so only the
approved job sees them):

```text
E2E_SUPER_ADMIN_EMAIL
E2E_SUPER_ADMIN_PASSWORD
E2E_SUPERVISOR_EMAIL
E2E_SUPERVISOR_PASSWORD
E2E_BRANCH_EMAIL
E2E_BRANCH_PASSWORD
```

Retired: `E2E_STAFF_EMAIL`, `E2E_STAFF_PASSWORD`. The workflow no longer reads them; delete them if they exist.

### 5.3 Provisioning procedure (owner, after this commit is pushed and deployed)

Do this from the owner's own Super Admin session. Do not reuse the owner's password for any of these accounts.

1. **Mailboxes.** Use addresses the owner controls (for example plus-addresses on the owner's mailbox), clearly named, such as
   `…+e2e-smoke-admin@…`, `…+e2e-smoke-supervisor@…`, `…+e2e-smoke-branch@…`. Password reset must reach the owner.
   **Required since P44R:** the part before the `@` must contain `e2e-smoke` (any case), or the deploy fails before any write.
2. **Generate each initial password locally**, never in a shared terminal log:
   `node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url')+'-Aa1')"` and paste it straight into
   the create dialog. (The suffix guarantees the upper/lower/digit/special classes `strongPasswordSchema` requires.)
3. **Supervisor:** Admin → Supervisors → Add Supervisor. Name `E2E Smoke — Automation (do not use)`. Branch: the pilot branch only.
4. **Branch account:** Admin → Branches → pilot branch → Manage → Account → create. Label it as automation.
5. **Super Admin: there is no UI for it.** The API allows it (`POST /api/employees` with `role: "super_admin"` and one
   `branch_ids` entry, by a Super Admin; verified locally). Doing it in production is a **raw API write the owner must decide on**;
   P44 did not do it. If the owner prefers, the smoke can drop to Supervisor + Branch only by removing the Super Admin test, at
   the cost of no `/admin/*` coverage.
6. **First login, forced password change.** Every new account has `must_change_password=true`; the smoke cannot pass until it
   is cleared. Creating an account also sends an `employee_welcome` email **containing the initial password** (in development
   the stub prints it to the API log instead). So the initial password must be treated as disclosed: in a private window, sign
   in once as each account, set a **new** generated password (step 2) that only ever goes into the GitHub secret, sign out,
   and delete the welcome email.
7. **No 2FA on these accounts.** The smoke cannot answer a TOTP challenge. `require2faForAdmins`/`require2faForSupervisors`
   exist in settings types but are not enforced anywhere today. If 2FA becomes mandatory, these accounts need an explicit,
   documented decision; no exemption was added.
8. **Secrets, hidden input:** `gh secret set E2E_SUPER_ADMIN_PASSWORD --env production` (prompts without echo; repeat for each
   of the six names). Never pass the value on the command line, and never paste it into an issue, PR, screenshot or chat.
9. **Delete** `E2E_STAFF_EMAIL`/`E2E_STAFF_PASSWORD` if present: `gh secret delete E2E_STAFF_EMAIL --env production` (and at
   repository level if they were set there).
10. **Login budget:** a run uses 4 login-limiter hits spread over 4 device ids. Do not re-run the smoke in a tight loop; leave
    15 minutes after any failed-login investigation.
11. **Deactivation:** if an automation account is ever suspected compromised, deactivate it (Admin → Supervisors / Branches),
    which stops logins immediately; then rotate and re-set the secret.

Nothing reaches the repository, logs, screenshots, HARs or reports: the configs capture no artifacts, passwords are wiped from the
DOM right after submit, and error messages name variables, never values.

## 6. Local verification

**Setup (2026-10-28, all `127.0.0.1`):** new disposable database `p44_verify` on the local Postgres (`:5432`). The target was
printed and checked (`127.0.0.1:5432/p44_verify`) immediately before `prisma migrate deploy` (89 migrations) and before the seed
(`ALLOW_DATABASE_SEED=true`, `NODE_ENV=development`). Local Supabase Storage (`:54321`). Freshly built `packages/shared`,
`apps/api` (`node dist/server.js` on `:4440`) and `apps/web` (`next build` + `next start` on `:3440`, API rewrite to `:4440`).
The local `.env` sets no Sentry or Resend key, so nothing left the machine. Afterwards: both servers stopped and `p44_verify`
dropped (confirmed gone).

### 6.1 Guards (no browser, no network)

- `node --test tests/e2e/helpers/guards.node-test.mts`: **8/8 passed** (no default production target; only approved/local
  origins; production refused by the isolated resolver even when "confirmed"; remote needs an exact host; write allow-list;
  realtime blocked by default; direct-DB fixtures refuse remote URLs and never echo the value).
- `playwright test --list` with no E2E variables set and no `.env.e2e`:

| Case | Result |
| --- | --- |
| pilot config, no `PLAYWRIGHT_BASE_URL` | refused: "must be set explicitly … there is no default target" |
| pilot config, `https://staging.example.test` | refused: "neither an approved production origin nor local" |
| production config, no `PLAYWRIGHT_BASE_URL` | refused (same message) |
| isolated config, `https://www.potatorenovare.com` | refused: "is production — mutating E2E suites never run against production" |
| isolated config, `https://potatorenovare.com` + `E2E_ISOLATED_REMOTE_HOST=potatorenovare.com` | refused (same) |
| isolated config, `https://e2e.example.test` unconfirmed | refused: names `E2E_ISOLATED_REMOTE_HOST` |
| pilot config, production URL, no credentials | fails at load: `Missing required env var E2E_SUPER_ADMIN_EMAIL` |
| pilot config, production URL, only admin + supervisor set | fails at load: `Missing required env var E2E_BRANCH_EMAIL` |
| isolated config, default target | collects 0 production-credential specs; `expenses.spec.ts` collected |
| production config, production URL | collects only the 6 read-only `.production` specs (16 tests); no expenses |

- `p37-branch-stock.cjs` with a fake remote `DATABASE_URL`: refused before connecting ("DATABASE_URL is not local"); the fake
  password did not appear in the output.
- Typecheck of all 15 changed/new E2E TypeScript files (`tsc --strict`, node types from `apps/api`): **0 errors** (this
  includes removing one pre-existing error in `prod-login.ts`).
- `actionlint` 1.7.7 with shellcheck (Docker, `--network none`, read-only mount) on `ci.yml` and `deploy-production.yml`:
  **exit 0**.

### 6.2 Provisioning rehearsal and the production-safe smoke

Provisioning rehearsed through the real API as the seeded local Super Admin (the procedure in §5.3, scripted):

- `POST /api/employees/supervisors` (supervisor, pilot-branch stand-in `MAIN01`): **201**.
- `POST /api/employees` role `branch` on `MAIN01`, which already had a branch account: **201**. A second branch account is allowed.
- `POST /api/employees` role `super_admin`: **201**. The API allows it; the UI has no path.
- All three came back `must_change_password=true`. First login + `POST /api/auth/change-password` (needs the `X-Device-Id`
  header): **200** each. Passwords came from `crypto.randomBytes` and were never printed.

`pilot-smoke.spec.ts` with those three dedicated accounts, `PLAYWRIGHT_BASE_URL=http://localhost:3440`:

| Run | Result | Cause / change |
| --- | --- | --- |
| 1 (`127.0.0.1:3440`) | 3 passed, 3 failed | Host mismatch: middleware redirects to `localhost`, cookies were on `127.0.0.1` (local only). Plus the harness-caused workbox `.waiting` error. |
| 2 (`localhost:3440`) | 3 passed, 3 failed | `Unexpected token '<'`: real app defect, §6.3 |
| 3 | **6/6 passed** (38.9 s) | after the narrow allowances |
| 4 | **6/6 passed** | before/after row diff over every table (footprint in §4.1) |

Guard probes (a throwaway spec, not committed), against the same stack:

- A page `fetch('POST /api/expenses')` as Super Admin: aborted in the browser, recorded as `POST /api/expenses`. **Passed.**
- Branch account on the locked terminal types a PIN and presses Continue: `POST /api/staff-pin/branches/<id>/verify-pos` was
  **aborted**; the screen stayed on "Open POS Terminal". No verification, no clock-in. **Passed.**
- A test using the guarded `test` fixture that POSTs `/api/products`: the fixture teardown **failed the test** (asserted with
  `test.fail`). **Passed.**

Leak checks: none of the three current passwords appears in any run log, API log, web log or Playwright report; `test-results/`
was empty after the smoke runs (`preserveOutput: 'never'`). The account emails do appear in the API log, as expected.

### 6.3 Defect found: `swe-worker-<hash>.js` is redirected to `/login`

**Fixed in POS-PERF-P44R** (`pos-perf-p44r-worker-routing-and-smoke-guards.md`); the smoke allowance below is removed.

`apps/web/middleware.ts`'s matcher exempts `sw.js` and `workbox-*` but not `swe-worker-<hash>.js`, which next-pwa now emits.
A signed-out page load requests it as a script; the middleware redirects it to `/login`, the browser receives HTML, and throws
`Unexpected token '<'`. Reproduced with service workers **allowed** as well (real browsers), so it is not a harness artifact.
The service worker itself (`/sw.js`) still registers. It is pre-existing and unrelated to P44.

**Not fixed here** (no app code in this task). The smoke tolerates exactly this case and records a `known-defect` annotation;
any other script served as HTML, or any other page error, still fails. The fix is one entry in the middleware matcher
(`swe-worker-`); remove `KNOWN_HTML_SCRIPT` from `pilot-smoke.spec.ts` in the same change.

### 6.4 Mutating E2E still targets disposable infrastructure

- `expenses.spec.ts` (moved from production) under the isolated config: every request went to the local stack. The API
  answered from `p44_verify` (`VALIDATION_ERROR incurred_at: Invalid ISO date`), and 0 expense rows remained. **7/7 failed. The
  suite is stale against the current app**: `incurred_at` is now date-only, and the admin sidebar has no Expenses link since
  P40. It was already broken before P44 (it would have failed in production too). Not repaired here.
- `pos-perf-p37-multi-branch-builder.spec.ts` with `DATABASE_URL` set to `p44_verify`: its direct-Prisma fixture passed the
  local-DB guard, and its writes (1 inventory item, 2 transactions, 2 attendance rows) landed **only in `p44_verify`**. The
  browser test then **failed** on a product-builder locator (the builder changed in P38–P41), so this spec is stale too.
- A third run (`pos-perf-p40r2-proof-and-nav`) failed in `global-setup.ts`: the P37 flow had changed seeded passwords.
  **The isolated suites need a fresh database per run**; they are not idempotent.
- Pass/fail of the full isolated suite was not re-established here. It is out of P44's scope, and the stale specs above
  show it needs its own maintenance pass.

A process outside this session deleted this session's temp folder during the run (servers kept running). Lost: the rehearsal
password file and raw logs. The results above were recorded before the deletion. Separately, the local Postgres container was
restarted outside this session at the end; `p44_verify` was dropped after it came back.

## 7. Owner pilot checklist and evidence template

All items are **PENDING** until the owner (or a real cashier, during normal legitimate work) observes them. Record timings only
from real observation; leave a cell empty rather than estimate. No test transactions in production for this checklist.

### Cashier (pilot branch terminal)

| # | Check | Observed? | Who / when | Notes (timing only if measured) |
| --- | --- | --- | --- | --- |
| C1 | PIN entry opens the POS and the header shows the correct cashier | PENDING | | |
| C2 | Tapping a product adds it immediately | PENDING | | |
| C3 | Rapid repeated taps keep the intended quantity | PENDING | | |
| C4 | Stock-check "checking" and failure states are understandable (P41R policy) | PENDING | | |
| C5 | Normal checkout completes; Next Customer clears the cart | PENDING | | |
| C6 | Receipt number = transaction number; payment proof attached when used; background deduction reconciles in Order Deductions | PENDING | | |

### Supervisor

| # | Check | Observed? | Who / when | Notes |
| --- | --- | --- | --- | --- |
| S1 | Product editor: inline forms, clear save feedback | PENDING | | |
| S2 | Draft / Active / Inactive classification is correct | PENDING | | |
| S3 | Publishing to the selected branch only; other branches unaffected | PENDING | | |
| S4 | Branch-specific Work Hours | PENDING | | |
| S5 | Staff and PIN management | PENDING | | |

### Admin

| # | Check | Observed? | Who / when | Notes |
| --- | --- | --- | --- | --- |
| A1 | Branches and Supervisors navigation | PENDING | | |
| A2 | Attendance shows the right scope | PENDING | | |
| A3 | Transaction PDF and authorized proof downloads | PENDING | | |
| A4 | Proof dialog returns keyboard focus to the View Proof that opened it | PENDING | | |

### Evidence template (one per pilot day)

```text
Date / branch:
Release (prod tag + SHA):
Deploy run + smoke result (passed / skipped / failed + failing test name):
Checklist items observed today (IDs):
Issues seen (what, when, screenshot location — no credentials or customer data in screenshots):
Transaction numbers referenced (real sales only):
```

## 8. How this fits the P43 pipeline

Unchanged order: validate (exact `main` SHA) → owner approval → tip guard → Render preflight → staged Vercel build → migrations →
Render deploy + exact-SHA verify → promote via API → `vercel-verify` → **smoke** → release tag. P44 only changes what the smoke
step runs and two of its env names. With secrets unset it still skips with the same notice. When it runs and fails, the release
tag step does not run; production is already promoted at that point, so a smoke failure is a signal to roll back by the P43
procedure, not an automatic rollback.

## 9. Remaining prerequisites and owner actions

Awaiting the owner, in order. None was done by P44:

1. **Push** this commit (and `8999e5c` beneath it) and run the gated deploy. With no E2E secrets set, the smoke step still
   skips, so this is safe before step 2. The new CI step "E2E guard tests" runs in `ci.yml`.
2. **Decide on the Super Admin automation account** (§5.3 step 5): create it via an owner-run `POST /api/employees`, or drop
   the Super Admin smoke test. This is the only provisioning step with no UI path.
3. **Provision** the Supervisor and second Branch account on the pilot branch (§5.3), and the Super Admin per step 2. Complete
   each first login and password change, and delete the welcome emails.
4. **Set the six secrets** in the `production` environment with hidden input; delete `E2E_STAFF_*` if present.
5. **Next deploy**: the smoke runs for real for the first time. Record the result in the evidence template (§7). A failure
   after promote means: roll back per P43, then investigate.
6. ~~**Fix the `swe-worker` matcher** (§6.3) in a normal reviewed change, and remove the smoke's allowance with it.~~ Done in
   POS-PERF-P44R.
7. **Pilot checklist** (§7): observe during normal work and fill in; all items PENDING.
8. **Isolated E2E maintenance** (separate task): repair stale specs (`expenses`, `p37`, and others not re-run), and decide
   whether a remote isolated environment is wanted. Creating one (database, Storage, API, web) is a platform/resource
   decision for the owner; no paid upgrade is proposed here. Until then, mutating E2E is local-only, with a fresh database per run.

Known risks carried forward:

- The Super Admin automation account has full read access and no 2FA. Mitigations: a long random password stored only as an
  environment secret, used only by the gated job, visible in audit (`LOGIN_SUCCESS`), and deactivatable instantly.
- Read-side audit rows (`REPORT_ACCESSED`, about 19 per run) will appear in production audit logs, attributed to the automation
  accounts.
- Local build artifacts: `apps/web/.next` and `apps/api/dist` were rebuilt from this tree, with the web build pointing at API
  `:4440`. Rebuild before reusing them with another API port.
