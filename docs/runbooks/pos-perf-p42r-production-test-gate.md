# POS-PERF-P42R — Production test gate: what ran, what changed

Starting HEAD: `069fd8c9149467eb1c3de734791d0b4a9650b072` (P42 stock-check test fix).
Released baseline and `origin/main`: `a2fe6e5c0c3f032e12bc8442f1efdfa66994c355`.

This change is local only. Nothing was pushed, no workflow was dispatched, and nothing in production
was contacted or changed. No dashboard setting (GitHub, Vercel, Render) was changed, and no
credential was read or rotated.

## 1. What run 40643248740 actually did

Source: [Deploy to Production #40643248740](https://github.com/cjlonzaga29-pixel/potato-corner-web-pos-main/actions/runs/40643248740).
This was read through `gh run view` (metadata, jobs, steps), the approvals API and the full job
log. Workflow file: `.github/workflows/deploy-production.yml` **as it was at `a2fe6e5`**. HEAD's copy
was identical before this change.

| Fact | Evidence |
| --- | --- |
| Event and SHA | `push` to `main`; `head_sha` `a2fe6e5c0c3f032e12bc8442f1efdfa66994c355`; attempt 1. The checkout step fetched `+a2fe6e5…:refs/remotes/origin/main` and logged that SHA. |
| Jobs | **One job**, `deploy-production`, with `environment: production`. No reusable workflow, composite action or artifact prerequisite. Tests ran **directly**, as a `run:` step. |
| Approval | One approval by the repository owner for `production`. The run was created at 06:20:27Z, and the job only started at 06:24:58Z, after the approval. **The approval came before any validation.** |
| Test DB | Step 9 applied all 89 migrations to the job's service container, `localhost:5432/potato_corner_test`. |
| Validation (step 10, "Full CI validation", 06:25:48Z–06:31:06Z) | `pnpm run type-check`: 4/4 turbo tasks. `pnpm run lint`: 4/4 tasks, 0 errors (308 warnings in one package, 1 in another). `pnpm run test`: shared **4 files / 30 tests passed**; API **193 passed, 1 skipped (194) files; 3,267 passed, 5 skipped (3,272) tests**; web **153 / 153 files; 1,354 / 1,354 tests**. `pnpm run build`: 3/3 tasks. |
| Production migrations (step 11, 06:31:06Z) | Target `aws-0-ap-southeast-2.pooler.supabase.com:5432`, database `postgres`. "89 migrations found", **"No pending migrations to apply."** |
| Render (step 12, 06:31:13Z) | The deploy hook `curl` ran and succeeded. The secret was present. |
| Smoke tests (steps 14–15) | **Skipped.** `E2E_SUPER_ADMIN_EMAIL` is not set. |
| Release (step 16) | `prod-20261028-063158` was created with `--target main`, not the exact SHA. main was still `a2fe6e5` at the time, so it was correct in this run. |
| Other runs on `a2fe6e5` | None (`gh run list --commit`). `ci.yml` runs only on `pull_request`, and `main` has **no branch protection**. |

**Resolving the contradiction.**
- "No tests ran" is false. All four suites ran and passed on the exact SHA, before the migration and
  the Render hook.
- "CI passed, then the owner approved" is also false. The approval came first, and the tests ran inside
  the approved job.
- So the old gate did stop production writes on a failing test. But it asked the owner to approve an
  unvalidated commit, and the only check on a main push was inside the environment that holds the
  production secrets.

**Not verified here:**
- Vercel's deployment of `a2fe6e5`: there is no Vercel access in this task.
- Whether Render's own auto-deploy is also enabled for the API service. It is dashboard-only, with no
  `render.yaml`. If it is enabled, Render deploys on push regardless of the hook, and the API is not
  gated either (§4).

## 2. The gap and the fix

**Proven gaps at `a2fe6e5`:**
1. **Validation ran after approval.** It was inside the `environment: production` job.
2. **No concurrency control.** Two main pushes could run migrations and Render hooks at once, or out of
   order.
3. **The release was tagged at `main`, not at the deployed SHA.**

**New `deploy-production.yml` (push to `main` only):**
1. `validate` calls `ci.yml` through `workflow_call`.
   - It is the same job PRs run: Postgres service, test-DB migrations, `type-check`, `lint`, `test`
     (shared, API, web) and `build`.
   - There is only one definition to maintain.
   - It runs outside the environment, with `contents: read` and **no secrets**. It checks out
     `github.sha`, the pushed commit.
2. `deploy-production` has `needs: validate` and `if: github.ref == 'refs/heads/main'`.
   - If validate fails or is cancelled, the job is skipped. **No approval is requested, and no production
     secret is exposed.**
   - Environment `production` still has its required reviewer. The approval is requested only after
     validate passes on the same SHA.
3. Inside the deploy job, before any write:
   - **Superseded-commit check:** if main's tip (from the API) is no longer `github.sha`, every later
     step is skipped with a notice.
   - Then `migrate deploy`, the Render hook, the smoke tests (still skipped while their secret is unset)
     and the release, now tagged `--target "$GITHUB_SHA"`.
   - The test-DB services and the duplicated test steps were removed from this job. They now run in
     validate.
4. `concurrency: { group: deploy-production, cancel-in-progress: false }` is set on the **deploy job
   only**, so validation of different pushes runs in parallel.
5. `ci.yml` gains only `workflow_call: {}` and a comment. Its PR trigger and steps are unchanged.
6. **No `workflow_dispatch`** was added. The environment has no deployment-branch policy, so a dispatch
   could deploy any branch.
   - To retry, use "Re-run jobs". That re-runs validate on the same SHA.
   - Re-running an old run doesn't redeploy stale code, because the tip check skips it.

## 3. Scenarios

Checked by reading the workflow logic. They can't be run until pushed (§5).

| Scenario | Behaviour |
| --- | --- |
| Main push, all green | validate passes, then the owner gets the approval prompt, then the tip check, migrate, Render, wait, smoke (if configured) and the release at the exact SHA. |
| Test, lint, type-check or build fails | validate fails. The deploy job is **skipped**: no approval prompt, no secrets, no migration, no Render hook, no release. **Vercel has already deployed the web** (§4). |
| Manual dispatch | There is no trigger. "Re-run all jobs" re-runs validate, then deploy, on the run's own SHA. |
| Push A, then push B quickly | Both validate in parallel. The deploy jobs share the group: one runs, and a newer pending one replaces an older pending one, which is cancelled before any step runs. A running deploy is never cancelled. If A's deploy starts after B reached main, the tip check skips A and B deploys. If A is mid-migration when B arrives, B waits, then deploys. |
| B fails validation after A was skipped as stale | Nothing deploys: production stays on the earlier API. Fix forward with a new push. The tip check never deploys stale code. |
| PR to main or staging | `ci.yml`'s `pull_request` trigger and job are unchanged. |
| Staging (`deploy-staging.yml`) | Unchanged. It still validates inside its `environment: staging` job. Out of scope here. |

**Unverified GitHub detail:** does a job waiting for environment approval hold, or wait for, the
concurrency slot? The design is safe either way: the cancelled job had run nothing, and the tip check
runs after both.

## 4. Vercel (and possibly Render): what is *not* gated

- **The web is not gated.** Vercel's GitHub integration builds and promotes `apps/web` on every push to
  `main`, independently of GitHub Actions. There is no `vercel.json` in the repo; the setting lives in the
  Vercel dashboard.
  - The web can be live before validate finishes.
  - It stays live if validate fails.
  - This change protects **production migrations, the Render deploy hook and the GitHub release only**.
- **Render:** the API is gated only if the Render service's Auto-Deploy is **off**, which is not verified.
  This task did not inspect or change it.

**Owner procedure to gate the web too (not done; needs a dashboard decision):**
1. **Preferred, smallest change: Vercel Deployment Checks.**
   - In Vercel → Project → Settings → Deployment Checks, add the GitHub check for this workflow's validate
     job. It appears on main commits as **`validate / validate`** after the first push of this change.
   - Vercel still builds, but only promotes to the production domains once that check passes.
   - Confirm that the feature is available on the current plan, and that the check name matches, before
     relying on it.
   - **Limit:** the web would then go live after validate but *before* approval and migrations. The
     new-web/old-API compatibility analysis in the P40 runbook §11.4 still applies.
2. **Strict ordering: deploy the web from this workflow.**
   - Disable Vercel's production auto-deploy for `main` (`git.deploymentEnabled` in `vercel.json`, or the
     dashboard).
   - Add a `vercel deploy --prod` step to `deploy-production` after the Render hook. It needs a
     `VERCEL_TOKEN` (plus org and project IDs) as `production` environment secrets.
   - This is a larger change, with a new secret and a new deploy path. Do it only with the owner's
     sign-off.
3. **Render:** confirm Auto-Deploy is **off** for the production API service, so that only the gated hook
   deploys it. If it is on, turning it off is the owner's call, not this task's.
4. **Optional:** add branch protection on `main` that requires the PR `validate` check. This stops
   unvalidated direct pushes from reaching Vercel at all.

## 5. Validation of the workflow change

- `actionlint` 1.7.7 (Docker image `rhysd/actionlint:1.7.7`, already cached, `--network none`,
  read-only mount, with shellcheck) on all workflows: **exit 0, no findings.**
- PyYAML parse: both files load. Jobs: `ci.yml` → `validate`; `deploy-production.yml` → `validate`,
  `deploy-production`.
- The IDE's "Context access might be invalid: E2E_*" warnings are pre-existing. Those secrets are unset,
  which is why the smoke steps skip.
- **Only verifiable after a push:**
  - that the reusable call resolves and the check is named `validate / validate`;
  - that the approval prompt appears only after validate;
  - the tip-check API call (it uses `github.token` with `contents: read` or `write`);
  - how concurrency interacts with the approval wait.

  The first push of this change is itself the test: watch that run before approving.

## 6. Web test evidence

### 6.1 The kept stock-check fix (`069fd8c`) — what it does and doesn't fix

- **Race removed:** in "timed-out check, then retry", the retry inherited the 20 ms real-time timeout.
  On a loaded host it could time out before the "still checking" assertion, and fail with
  `unverified`. The retry now gets a 60 s timeout through `rerender`.
- **Not fully deterministic.** The test still uses real timers:
  - the first request's 20 ms timeout, then `wait(40)`;
  - it relies on Node firing the earlier-deadline timer first, which is ordinary timer ordering.
- **Defect found here:** `069fd8c` broke `tsc --noEmit` for `apps/web`. `initialProps` inferred
  `timeoutMs` as a required key, so the two cashier/branch-switch `rerender` calls (lines 220 and 227) no
  longer type-checked.
  - CI's type-check would have failed on it, and so would the new validate gate.
  - **Fixed** by giving `renderHook` the explicit props type with `timeoutMs?`.
  - That test uses `setup()` without a timeout, so the runtime is unchanged.

### 6.2 Login countdown test (clock dependency proven, replaced)

- `login-form.tsx` sets the expiry to `Date.now() + expiresIn*1000`. It shows
  `Math.round((expiry − Date.now())/1000)` and re-reads that on a real 1 s `setInterval`.
- The old test expected exactly `2:05` within `waitFor`'s 1 s window. Two things would fail it:
  - more than about 500 ms between submit and the first effect;
  - a tick landing before `waitFor` matched.
- **Proof:** a temporary test file (deleted, never committed) stalled one render for 700 ms after the
  challenge was accepted, using `performance.now()`.
  - The old form failed: "Unable to find … 2:05".
  - The controlled-clock form passed.
- **Now:** the test fakes only `Date`, `setInterval` and `clearInterval`. `setTimeout` stays real, so
  `waitFor` and promise flushing still work.
  - It asserts `2:05`, then `2:04` after advancing 1 s.
  - **New expiry test:** at 124 s it shows `0:01`. At 125 s the TOTP field is gone, the credentials form
    is back, and "Session expired — please log in again" is shown. This path had no coverage before.

### 6.3 Full web suite (one run)

- **Preflight:** 4 cores, 7.7 GB RAM, **0.7 GB free, 73–90% CPU**. The load was the owner's Chrome,
  VS Code, Viber and Docker/WSL. No node process was running, and nothing was stopped.
- **Code:**
  - HEAD `069fd8c9149467eb1c3de734791d0b4a9650b072`;
  - plus the uncommitted workflow changes and the login test change from this commit.
  - It did **not** include the later type-only `renderHook<…>` annotation (§6.1). That annotation is
    erased at transform, so the code that runs is identical.
- **Command** (in `apps/web`): `npx vitest run --pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1`.
  - It ran with no exclusions and default timeouts.
  - Nothing else ran at the same time: no build, no browser tests, no other suite.
- **Log:** the session scratchpad, `web-suite-p42r.log` (not committed).
- **Result: exit code 0** (07:03:45Z–07:14:46Z).
  - Test files: **153 passed (153)**.
  - Tests: **1,355 passed (1,355)**. That is CI's 1,354 at `a2fe6e5` plus the new expiry test.
  - Duration: 655.6 s.
  - No failures, no timeouts and no retries.
- **After the annotation:**
  - `apps/web` `tsc --noEmit`: exit 0;
  - eslint on both changed test files: exit 0;
  - both files re-run on one fork: **2 files / 36 tests passed**.
- **Earlier failed local runs stay recorded as they were.** See the P41 runbook §4 and §8.5 (67 failures;
  then 1 failure, exit 1) and §9.3 (the first clean run, exit 0).
- API and shared suites were not run locally in this pass, and their code is unchanged. Their last
  full results on these sources are in run 40643248740 (§1).

## 7. Remaining (owner / platform)

1. Push, then **watch the first run of the new workflow before approving**:
   - validate should appear and pass first;
   - the approval prompt should come only after that;
   - the check name should be `validate / validate`.
2. Vercel gating decision (§4, option 1 or 2). Until then, the web deploys on every main push without
   validation.
3. Confirm Render Auto-Deploy is off for the production API (§4.3).
4. Optional: branch protection on `main` (§4.4).
5. `deploy-staging.yml` keeps the old validate-inside-environment shape. It also lacks the test-DB
   service and the `.env` URL rewrite that `ci.yml` has, so its API integration tests may not behave the
   same way. This was not changed or checked here.
