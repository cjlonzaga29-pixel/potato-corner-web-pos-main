# POS-PERF-P44R — Worker script routing fix and smoke account guards

Starting local HEAD: `7eb2cc0945796db36a078c05cf77866966ca3888` (P44, unpushed), with `8999e5c` (P43R2 evidence, unpushed)
beneath it. `origin/main` = production: `abee6020a3cd4d50c4b24e3b2887c2c64b31d62f`. After `git fetch`: no drift, HEAD 2 ahead,
0 behind. Both unpushed commits are preserved and ship with this one.

No migration, schema, API, Render or Vercel configuration change. No account, secret or production record was created.

## 1. Root cause (reproduced, not assumed)

next-pwa emits three public scripts into `apps/web/public` on every production build. The names below are from this tree's
fresh build:

| File | Who requests it | Before P44R (signed out) |
| --- | --- | --- |
| `sw.js` | `workbox-window` registers it | 200 `application/javascript` (matcher-excluded since Phase 20) |
| `workbox-5194662c.js` | `sw.js` (`define(["./workbox-…"])`) | 200 `application/javascript` (matcher-excluded) |
| `swe-worker-5c72df51bb1f6ee0.js` | **every page**: `new Worker("/swe-worker-…js")` in the main bundle; also in `sw.js`'s precache list | **307 → `/login?returnTo=%2Fswe-worker-…js` → 200 `text/html`** |

`swe-worker-<hash>` is `swe-worker-${getFileHash(sw-entry-worker.js).slice(0, 16)}.js` (next-pwa `dist/index.cjs`). The
middleware matcher excluded `sw\.js` and `workbox-` but not this third file, so it went through the auth middleware.

Browser evidence (local production build, Chromium, service workers **allowed**, signed out, `/login`):

- Page: `pageerror: Unexpected token '<'`: the dedicated worker received login HTML.
- `sw.js` still registered, but its install fetched `/swe-worker-…js`, received the 307, and precached login HTML under that
  URL.
- Effect: next-pwa's `cacheOnFrontEndNav` / `aggressiveFrontEndNavCaching` (in `next.config.ts` since Phase 20) has never
  worked in production. Those settings run inside this worker.

## 2. Fix

`apps/web/middleware.ts` matcher, one negative-lookahead alternative replacing the two prefix exclusions:

```text
(?:sw|workbox-[0-9a-f]+|swe-worker-[0-9a-f]+)\.js(?:\.map)?$
```

- Exact generated shapes only: root path, hex content hash, `.js` or `.js.map`, then end of path. This is not a `*.js` or
  "contains worker" rule.
- It is also tighter than before: `sw\.js` and `workbox-` were prefixes, so `/sw.jsx` or `/workbox-admin` skipped the
  middleware. Both are now protected. `sw.js.map` and `workbox-*.js.map` stay public, as they already were; `swe-worker-*.js.map`
  joins them.
- The compiled matcher in `.next/server/middleware-manifest.json` carries the alternative unchanged.
- `apps/web/middleware.test.ts` evaluates the exported `config` with Next's own `unstable_doesMiddlewareMatch`: 6 generated
  paths exempt, and 18 pages and lookalikes still matched (`/swe-worker-admin`, `/swe-worker-NOTHEX.js`, `/swe-worker-<hash>.js/admin`,
  `/swe-worker-<hash>.jsx`, `/sw.js/admin`, `/sw.json`, `/workbox-admin`, `/admin/swe-worker-<hash>.js`, `/worker.js`, `/private.js`,
  `/login`, `/admin/dashboard`, …). A signed-out lookalike is redirected to `/login`.

`tests/e2e/pilot-smoke.spec.ts`: `KNOWN_HTML_SCRIPT` and the `Unexpected token '<'` allowance are removed, so that error fails
the test again. P44 §6.2 run 2 shows it does: 3 tests failed on exactly this before the allowance existed. In addition, any
page `.js`/script response served as `text/html` is recorded as an error by name. The only remaining ignored error is the harness-caused workbox `.waiting` message (service workers blocked by config).

## 3. Smoke account guards

Before: the run/skip decision looked only at `E2E_SUPER_ADMIN_EMAIL`. A partial set failed at suite load, which is after promote,
so production was already switched. Nothing prevented a personal login from being stored in the secrets.

Now `deploy-production.yml` has a **Check production smoke accounts** step (`id: smoke`) next to the deployment-credential
check, before any production write:

| Secrets | Result |
| --- | --- |
| none of the six | `run=false`; smoke and Chromium install skipped; notice "Production smoke tests SKIPPED" |
| some but not all | fails, names the missing ones, **nothing deployed** |
| all six, an email without `e2e-smoke` before the `@` | fails, names the variable, **nothing deployed** |
| all six, all marked | `run=true`; smoke runs after promote and verify, as before |

Verified by extracting the step's script and running each case under bash with fake values (no value is echoed). The spec
enforces the same marker at load (`requireAutomationEmail`), so local runs cannot use a personal login either. Checked with
`--list`: an unmarked address is refused, and a partial set is refused with `Missing required env var …`.

## 4. Local verification (all `127.0.0.1` / `localhost`)

Fresh disposable database `p44r_verify` on the local Postgres (`:5432`). The target was printed and checked to be local before
`prisma migrate deploy` (all migrations applied) and the seed (`ALLOW_DATABASE_SEED=true`, `NODE_ENV=development`). Local
Supabase Storage. `packages/shared` and `apps/api` were built; the API ran on `:4441` (`API_PORT`), and the web ran with
`next build` + `next start -p 3441` (rewrite to `:4441`). The build was fresh: `.next` and the generated `public` scripts were
deleted first. The web build regenerated identical names. The only DB connections observed were to `p44r_verify`.
Afterwards: servers stopped and `p44r_verify` dropped.

| Check | Result |
| --- | --- |
| `curl` signed-out `/sw.js`, `/swe-worker-5c72df51bb1f6ee0.js`, `/workbox-5194662c.js` | 200 `application/javascript` each |
| `curl` `/swe-worker-admin`, `/swe-worker-<hash>.js/admin`, `/sw.js/admin`, `/workbox-admin`, `/swe-worker-<hash>.js.json`, `/admin/swe-worker-<hash>.js`, `/admin/dashboard`, `/branch/terminal`, `/supervisor/dashboard` | 307 → `/login?returnTo=…` each |
| Browser, SW allowed: dedicated worker | loads JS; **no `Unexpected token '<'`**, no page error |
| Browser, SW allowed: service worker | installing → `activated` in ~13 s; precached `/swe-worker-…js` is `application/javascript`, `redirected=false` |
| Browser, smoke config (SW blocked): worker behaviour | worker caches visited pages (`pages`) and their `/_next/static` assets, GET only; the only non-GETs were the page's own login/refresh |
| Middleware tests | 30/30 (`middleware.test.ts`, 3 new) |
| E2E guard tests (`guards.node-test.mts`) | 8/8 |
| `tsc --noEmit` apps/web; strict `tsc` on `pilot-smoke.spec.ts`; eslint on changed web files | 0 errors |
| `actionlint` 1.7.7 + shellcheck (Docker, `--network none`, read-only mount) on `ci.yml`, `deploy-production.yml` | exit 0 |

### 4.1 Pilot smoke with dedicated local accounts

Provisioned through the real local API as the seeded Super Admin (§5.3 of the P44 runbook, scripted): a supervisor, a second
branch account on `MAIN01`, and a Super Admin, all with `e2e-smoke` addresses. Each was created `must_change_password=true`
and had its password changed. Passwords were `crypto.randomBytes` values, never printed.

| Run | Result |
| --- | --- |
| 1 (first run after server start) | 5 passed, 1 failed: Super Admin `waitForURL` on a sidebar navigation exceeded the 30 s test timeout |
| 2 | **6/6 passed** (54.2 s) |
| 3 | 5 passed, 1 failed: branch test passed every assertion (including no page errors), then timed out in `logout`'s `waitForURL(/\/login$/)` |

No failure was a page error or a script-as-HTML error. To rule out the newly working worker, the branch flow (sign in →
dashboard → terminal → dashboard → log out) ran 4× with the real worker and 4× with the worker script stubbed to an empty
script. That stub is functionally the pre-fix state. **Real worker 4/4 OK; stubbed 2/4 timed out** (stuck on
`/branch/dashboard` after Log out, and on `/login` after Sign in). The intermittent timeouts are local-stack slowness present
without the worker, not caused by this change. They are close to the per-test 30 s budget, so a cold first production run may
hit them too: see §6.

### 4.2 Footprint (row-count diff over every table, `p44r_verify`)

| Run | Changes |
| --- | --- |
| 1 | `LOGIN_SUCCESS` +3, `LOGOUT` +2 (the failed test stopped before sign-out), `REPORT_ACCESSED` +19, `refresh_tokens` +7, `revoked_tokens` +2, `refresh_token_rotation_cache` +4, `report_snapshots` +1 |
| 2 | `LOGIN_SUCCESS` +3, `LOGOUT` +3, `REPORT_ACCESSED` +19, `refresh_tokens` +7, `revoked_tokens` +3, `refresh_token_rotation_cache` +4, `notification_preferences` +1 (Super Admin default row, first Settings visit) |
| 3 (snapshot taken 40 s after the run) | `LOGIN_SUCCESS` +3, `LOGOUT` +3, `REPORT_ACCESSED` +18, `refresh_tokens` +8, `revoked_tokens` +3, `refresh_token_rotation_cache` +5 |

Only session and read-audit/cache/default rows. `notifications` stayed 0, including 40 s after a run, past the 30 s presence
debounce. `login_attempts`, transactions, expenses, attendance, inventory and every other business table were unchanged. No
PIN was entered and nobody was clocked in.

Not re-run (unchanged by this task): the isolated mutating suites, `expenses.spec.ts`, and the P37 specs (still stale, per P44 §6.4).

## 5. Release

Normal P43 path: exact-SHA validation → owner approval → tip guard → deployment-credential check → **smoke-account check
(new; skips with no E2E secrets)** → Render preflight (autoDeploy must be off) → staged Vercel build → migrations (none new) →
Render deploy + exact-SHA verify → promote via API → `vercel-verify` → smoke (skipped) → release tag.

Preflight at commit time: no file under `apps/api/prisma` changed; `apps/web/vercel.json` still has
`git.deploymentEnabled.main: false`; the `production` environment holds all five deployment credentials and no `E2E_*`
secret; required reviewer configured.

## 6. Remaining

1. **Provision the smoke accounts and secrets** (separately scoped next task; P44 runbook §5.3, now with the mandatory
   `e2e-smoke` marker). Until then every deploy reports the smoke as SKIPPED.
2. **Smoke timing headroom:** the per-test 30 s timeout was exceeded intermittently on the local stack, with and without the
   worker. Watch the first real production run; if a test times out without a page error, raise that config's timeout in a
   reviewed change, not by retries.
3. **Front-end navigation caching is now live** for the first time. The worker re-fetches each navigated page (GET, with
   cookies) and caches the HTML and static assets in the browser's `pages` / `*-assets` caches, as `next.config.ts` has requested
   since Phase 20. That HTML is the app shell; data comes from the API. Observe during the pilot (checklist §7) that navigation
   and sign-out behave normally on terminals.
4. The pilot checklist and isolated-E2E maintenance from P44 §9 are unchanged.
