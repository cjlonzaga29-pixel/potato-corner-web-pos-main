# POS-PERF-P43 — Gated web deployment and verified API rollout

Starting HEAD and `origin/main`: `8d43150200334213ed5cf8e63f77a89a7b5bcfe5` (P42R2 audit-test fix). The tree
was clean, with no drift after `git fetch`.

This change is local only:
- Nothing was pushed or dispatched, and nothing was deployed.
- No GitHub, Vercel or Render setting was changed.
- No credential was read, stored or rotated.
- Production was read only through read-only APIs: `gh api` GETs and `vercel api` / `vercel inspect` GETs.

No POS or product code changed.

## 1. P42R2 release evidence (verified)

"Observed" means read here from GitHub or Vercel. "Code-reviewed" means inferred from the workflow file
as it ran.

| # | Fact | Basis |
| --- | --- | --- |
| 1 | **A failed validation blocked the API deploy.** [Run 40650179123](https://github.com/cjlonzaga29-pixel/potato-corner-web-pos-main/actions/runs/40650179123) on `ecc9ebb`: `validate / validate` failed at 07:31:10Z, and `deploy-production` was `skipped` (07:31:11Z). No approval was requested. | Observed (check-runs API, P42R runbook §8) |
| 2 | **A successful validation came before approval.** [Run 40651520586](https://github.com/cjlonzaga29-pixel/potato-corner-web-pos-main/actions/runs/40651520586) on `8d43150`: `validate / validate` ran 07:39:45Z–07:43:55Z (success). There was one `production` approval, by the repository owner. `deploy-production` started at 08:22:12Z. | Observed (jobs API + approvals API). The approvals API returns no timestamp. The order is shown by the job only starting after validate completed and after the approval. |
| 3 | In that run, the migration found "89 migrations… No pending migrations to apply". The Render hook returned HTTP 200 at 08:22:54Z with body `{"deploy":{"id":"dep-…"}}`. Smoke tests were skipped, and release `prod-20261028-082339` was created at the exact SHA. | Observed (job log). The id is withheld here and the URL is never printed. |
| 4 | **Vercel published independently, even when validation failed.** Vercel's Git integration created *Production* deployment `dpl_2mG484RPYy5LvhtkDWC9eg9NbhGA` for `ecc9ebb`. Its status was "Deployment has completed" at 07:29:29Z, **before** validate failed at 07:31:10Z. `vercel inspect` lists `potatorenovare.com` and `www.potatorenovare.com` among its aliases. Production stayed on that failing commit until `8d43150`'s Git deployment completed at 07:41:17Z. That deployment, `dpl_GjuUofuQEcYqMHdG3kfbTyoiPKz3`, holds both domains now. | Observed (GitHub deployments/statuses, `vercel inspect`, `vercel alias ls`, `/v4/aliases`) |
| 5 | **The fixed 45-second wait ended before Render was live.** `sleep 45` ran 08:22:54Z–08:23:39Z. Then the job went straight to the release, without checking Render. | The timestamps are observed. That Render was not yet live at 08:23:39Z comes from the task brief's P42R2 evidence. It cannot be re-observed here, because this task has no Render access. It is code-reviewed as possible by design: nothing in the job looked at Render after the hook. |

## 2. Platform facts that drive the design (read-only inspection)

- **Vercel project** `potato-corner-pos` (`prj_yVPZZumoPDxbGuADZ4JeetWCKl0V`):
  - team `cjlonzaga29-pixels-projects` (`team_ixozcUgz2KZlGr8LQ09X6AEr`), **plan: `hobby`**;
  - Root Directory `apps/web`, Next.js;
  - Git link `github` → `potato-corner-web-pos-main`, production branch `main`;
  - `autoAssignCustomDomains: true`;
  - `gitProviderOptions.createDeployments: enabled`;
  - no `vercel.json` anywhere in the repo.
- The production domains are `potatorenovare.com` and `www.potatorenovare.com`. Both alias the same deployment.
- `/v13/deployments/{id}` returns `readyState`, `target`, `projectId` and `meta.githubCommitSha`. For the
  current production deployment, `meta.githubCommitSha` is `8d43150…`.
- **Render:** the deploy hook response is observed (§1, row 3). The Render API, the service id and the
  Auto-Deploy setting are **not visible** to this task.

## 3. Choosing the web gate

**Requirements:**
- The exact pushed SHA validates first.
- A failed validation can never publish production.
- PR previews are kept.
- No paid upgrade.
- No duplicate production deployments.

| Option | Verdict |
| --- | --- |
| **Vercel Deployment Checks** (require `validate / validate`) | **Ruled out as the primary gate. It is kept as a fallback.**<br>• The docs say Vercel "will hold each production deployment until all required checks pass before assigning it to your custom production domains". The changelog says they are "available for all projects connected to GitHub repositories". But this task could not confirm availability on this Hobby team read-only: the project API exposes no checks config, and the endpoint probed returned 404. The brief says not to assume it.<br>• Even if it is available, the web would go live after validate but **before** owner approval, migrations and the new API. The new web could then call the old API or schema.<br>• It can be bypassed by "Force Promote".<br>• It depends on a check-name string. |
| Ignored Build Step (dashboard) | Ruled out. It is a dashboard-only change, invisible in the commit, and it's unclear how it would interact with CLI deploys. |
| `github.autoAlias: false` | Ruled out. Vercel's docs say to follow the staged-production workflow instead. |
| Vercel deploy hook | Ruled out. It builds the branch head, not a pinned SHA. |
| Staged prod (`vercel deploy --prod --skip-domain` + `vercel promote`) | Not needed now. It is a possible later refinement. |
| **Workflow-published web** (the [official GitHub Actions flow](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel): `vercel pull` / `vercel build --prod` / `vercel deploy --prebuilt --prod`), plus `git.deploymentEnabled` for `main` turned off **in the commit** | **Selected.**<br>• It works on Hobby.<br>• It builds the exact checkout.<br>• It runs only after validate, approval, migrations and a verified-live API.<br>• PR previews keep working, because only `main` is disabled ([git configuration](https://vercel.com/docs/project-configuration/git-configuration)). |

**One publisher per commit, decided by the commit itself.**
- The deploy job reads `apps/web/vercel.json` *at the deployed SHA*:
  - `git.deploymentEnabled` is `false`, or `git.deploymentEnabled.main` is `false` → **`workflow`** mode.
  - anything else (including no file) → **`git`** mode.
  - glob keys, or a non-boolean `main` → the job **fails**. It never guesses.
- Vercel reads the same file at the same commit to decide whether to Git-deploy it.
- So for any one commit, exactly one of them publishes. A double deploy is impossible, and so is an
  unpublished commit with a green run. That holds even if the switch commit lands mid-queue.
- **This commit does not add the file.** It ships in `git` mode, so behaviour is unchanged until the
  owner's cutover commit (§6).

## 4. Workflow changes (`deploy-production.yml`, `ci.yml`)

These are kept unchanged:
- `validate` via `ci.yml` (`validate / validate`), outside the environment and without secrets;
- `needs: validate`, plus `environment: production` with its reviewer;
- exact-SHA checkout;
- the latest-main tip guard before any write;
- the `deploy-production` concurrency group (`cancel-in-progress: false`);
- migrations before the API;
- the release at `--target "$GITHUB_SHA"`;
- no `workflow_dispatch`;
- the permissions (`contents: write`, `deployments: write` on the deploy job only; `contents: read` elsewhere).

New and changed in `deploy-production`, in order:

1. **Pinned target** (job `env`):
   - `VERCEL_ORG_ID=team_ixozcUgz2KZlGr8LQ09X6AEr` and `VERCEL_PROJECT_ID=prj_yVPZZumoPDxbGuADZ4JeetWCKl0V` (identifiers, not credentials);
   - `VERCEL_PRODUCTION_DOMAINS=potatorenovare.com,www.potatorenovare.com`;
   - `EXPECTED_SHA=${{ github.sha }}`.
2. **Determine web publisher for this commit:** `node .github/scripts/deploy-rollout.mjs web-mode`.
3. **Check deployment credentials:**
   - It runs before any write, and fails if any of these is empty: `PRODUCTION_DATABASE_URL_DIRECT`,
     `RENDER_DEPLOY_HOOK_PRODUCTION`, `RENDER_API_KEY`, `RENDER_SERVICE_ID_PRODUCTION`, `VERCEL_TOKEN`.
   - It prints names only.
   - It replaces the old "skip Render if the hook is unset" behaviour. A release can no longer be green
     without a verified API.
4. *(workflow mode only)* Install `vercel@59.11.7` (pinned), then `vercel pull --environment=production`
   and `vercel build --prod`.
   - This happens **before** migrations, so a web build failure stops the release with no production write.
   - The production env vars are pulled into the runner's `.vercel/`. The repo's `.gitignore` already
     ignores it, and nothing is printed.
5. Migrations (unchanged).
6. **Deploy apps/api to Render and wait until live** (`deploy-rollout.mjs render`, 30-minute step timeout,
   25-minute poll bound). This replaces `curl` and `sleep 45`.
7. *(workflow mode only)* **`vercel deploy --prebuilt --prod`**, after the API is live. The deployment URL
   becomes a step output.
8. **Verify production web is serving this commit** (`deploy-rollout.mjs vercel-verify`, both modes).
   - Both domains must alias **one** READY `production` deployment in the pinned project.
   - In git mode, its `meta.githubCommitSha` must equal the SHA.
   - In workflow mode, it must be **exactly the deployment created in step 7**, and any recorded SHA must
     agree.
   - The bound is 15 minutes.
9. Smoke tests (unchanged), only after steps 6 and 8 pass. If `E2E_SUPER_ADMIN_EMAIL` is unset, a
   **"Production smoke tests SKIPPED"** notice is printed instead of skipping silently.
10. Release, only if everything above succeeded. No step uses `always()`.

`ci.yml` gains one step, **Deployment script tests** (`node --test ".github/scripts/*.test.mjs"`). It has
no network and no secrets, so PRs and main pushes both run them inside `validate`.

## 5. Render rollout verification (`.github/scripts/deploy-rollout.mjs`)

**Contract:**
- [Deploy hooks](https://render.com/docs/deploy-hooks):
  - 200 returns the new deploy's id. The observed body is `{"deploy":{"id":"dep-…"}}`.
  - **202** means "queued behind another deploy", with **no id**.
  - `ref=<sha>` deploys that commit.
- [Retrieve deploy](https://api-docs.render.com/reference/retrieve-deploy): `GET /v1/services/{serviceId}/deploys/{deployId}`, with Bearer auth. It returns `id`, `commit.id`, `status` and `trigger`.

**Behaviour:**
1. `GET /v1/services/{id}`:
   - a 404 fails with "RENDER_SERVICE_ID_PRODUCTION does not name a service";
   - a different `id` fails;
   - `autoDeploy: "yes"` prints a `::warning::`, because Render would also deploy ungated.
     **Superseded by P43R (§10):** this is now a fail-closed preflight before any production write.
2. POST the hook once, with `ref=EXPECTED_SHA`.
   - It is **never retried**, because a lost response may still have started a deploy. Re-run the job instead.
   - Any status other than 200 or 202 fails.
3. On 200, poll **that deploy id** under the service. A 404 there means the hook belongs to another
   service, and the job fails.
4. On 202, wait for the newest deploy that meets all of these:
   - trigger `deploy_hook`;
   - `commit.id == EXPECTED_SHA`;
   - created after the trigger, with 2 minutes of tolerance for clock skew.

   Then follow that deploy. It never picks "the latest deploy".
5. **Statuses:**
   - **Success:** only `live` with `commit.id == EXPECTED_SHA`.
   - **Failure:** a different commit fails immediately. So does `live` with no commit.
   - **Failure:** `build_failed`, `update_failed`, `pre_deploy_failed`, `canceled`, `deactivated`.
     `deactivated` counts because a replaced deploy was never verified live.
   - **Pending:** `created`, `queued`, `*_in_progress`.
6. **Errors and time limits:**
   - These are retried: network errors, 408, 429 and 5xx, up to 5 in a row.
   - These fail at once: 400, 401, 403, 404 and 410.
   - One deadline (25 minutes, polling every 15 s) covers every phase.
7. **Secrets:**
   - The API key goes only in the `Authorization` header.
   - Each message is scrubbed of the hook URL and its path/query values, the API key and the Vercel token.
   - Network-error `cause` objects, which can contain the URL, are never printed.

`/health` is never used as evidence, and nor is the previously live deploy.

## 6. Transition: current state → gated web

**Current state.** Vercel's Git integration publishes every `main` push to production on its own, before
and regardless of validate or approval. The API deploys only through the gated hook, assuming Render
Auto-Deploy is off. That assumption is still not verified.

**Owner steps, in order.**

1. **Provision the secrets** in GitHub → Settings → Environments → `production`. Paste the values into
   GitHub's prompt only, never into chat, files or a shell history:
   - `RENDER_API_KEY`: Render → Account Settings → API Keys.
   - `RENDER_SERVICE_ID_PRODUCTION`: the production API service's `srv-…` id, from its dashboard URL.
   - `VERCEL_TOKEN`: Vercel → Account Settings → Tokens. Scope it to `cjlonzaga29-pixel's projects`, with
     an expiry.

   Prefer `gh secret set <NAME> --env production` with no `--body`; it prompts with hidden input.
   **This step must happen before pushing this commit.** Otherwise the credential check fails the run.
   That failure is safe: nothing is written, and you re-run once the secrets are added.
2. **Render:** in the production API service → Settings, confirm **Auto-Deploy is Off**. Since P43R the
   workflow fails before any production write if it is on, unknown or unreadable (§10).
3. **Push this commit (git mode).** Watch the run:
   - validate, then approval;
   - "web publisher: git";
   - the credentials check;
   - migrate;
   - the Render poll, showing `dep-…` progressing to `live at <sha>`;
   - the Vercel check passing on the Git-published deployment;
   - the release.

   **This is the first real test of the Render contract** (§8).
4. **Cutover commit (switches the web to the gated path, in one atomic step).** Add
   `apps/web/vercel.json`:
   ```json
   { "$schema": "https://openapi.vercel.sh/vercel.json", "git": { "deploymentEnabled": { "main": false } } }
   ```
   It has to be at `apps/web` because that is the project's Root Directory. Push it on its own, with no
   app changes, then verify:
   - `gh api "repos/cjlonzaga29-pixel/potato-corner-web-pos-main/deployments?sha=<sha>"` shows **no**
     `vercel[bot]` Production deployment for that SHA;
   - the run logs `web publisher: workflow`;
   - the run builds, deploys after Render is live, and the verify step names the new `dpl_…`;
   - a test PR still gets a Vercel preview.
5. **Do not** also disable Git deploys in the Vercel dashboard. The switch must stay in the commit, so
   that the workflow and Vercel agree per commit.
   - If someone does disable them in the dashboard, git-mode commits would publish nothing.
   - The verify step would then time out and fail, so it fails safe.
6. **Optional:**
   - Branch protection on `main`, requiring `validate`.
   - Once workflow mode is proven, Deployment Checks are unnecessary.

**To undo the cutover,** revert the `vercel.json` commit. That commit itself is then Git-published, in git mode.

## 7. Overlap, failures and retries

- **This is not atomic.** In workflow mode the order is: migrations, then the API rolls out (Render keeps
  the old instance serving until the new one is live), then the web uploads.
  - The windows are: old web against new schema and old API during the migration and rollout, then
    old web against new API until the alias swaps.
  - So releases must stay backward-compatible across one step: additive migrations, and an API that
    tolerates the old web. In git mode the window is reversed and longer: the new web goes live about
    2 minutes after the push, possibly hours before the approved API.
  - Schema-free compatible releases need no checkout pause.
  - For a future **incompatible** change, use the controlled gate procedure in the P40 runbook §11.4. Do
    not rely on ordering alone.
- **The API fails** (Render failed, cancelled, timed out, wrong SHA): the job fails, and there is no web
  deploy (workflow mode), no smoke test and no release.
  - Migrations already applied stay applied. **There is no automatic migration rollback.** Migrations are
    forward-only; fix forward.
  - Render keeps the previous live instance unless the new deploy went live. You can use Render's
    dashboard rollback if it did.
- **The API succeeds, the web fails** (build, deploy or verify): the job fails, and there is no release.
  Production is the new API with the old web, the case the compatibility rule above covers.
  - Retry with **Re-run failed jobs**. The tip guard re-checks that the SHA is still main's tip. The
    migration is a no-op, and Render deploys the same SHA again. Then the web is published.
- **The web succeeds, the API fails:** this can't happen in workflow mode, because the web comes after
  the API. In git mode it is possible, because the web is already out.
  - Fix forward, or roll the web back with `vercel rollback`.
  - Check what your plan allows first: Hobby rollback may be limited to the previous production
    deployment.
- **Retrying never deploys an outdated commit.**
  - There is no `workflow_dispatch`.
  - A re-run uses the run's own SHA, and the tip guard skips it if main has moved on.
  - Concurrency serialises deploys.
  - Git-mode verification fails, rather than passing, if a newer push has taken the domains mid-run.
- **Missing credentials:** the job fails in the credentials step before any write, and names the missing
  secrets.

## 8. Validation (local)

- **`node --test ".github/scripts/*.test.mjs"` (Node 24.18.0): 22 / 22 passed.**
  - The tests use an injected fetch and a fake clock: no network, no real sleeps.
  - They cover:
    - the previous live SHA not counting as success;
    - pending → live;
    - wrong SHA, wrong or unknown service, and a deploy on another service;
    - every failed or cancelled status;
    - live with no commit;
    - transient retries, then giving up, and auth errors failing fast;
    - timeout, and the shared deadline;
    - the 202 queued path ignoring older, foreign-commit and auto-deploy deploys;
    - the hook not being retried;
    - `web-mode` parsing;
    - Vercel previous-deployment, split-alias, building, wrong-project, preview-target and own-deployment cases;
    - CLI output never containing the hook URL, hook key, API key or Vercel token, including when an
      error message contains the URL.
- **Mutation check** (scratch copies; the repo was untouched): each of six injected faults is caught by
  at least one test:
  - SHA check removed;
  - canceled treated as OK;
  - any alias target accepted;
  - old production SHA accepted;
  - unbounded retries;
  - no sanitising.

  The alias mutation initially survived. The test was strengthened so that an older READY deployment of
  the same SHA is still rejected.
- **Live read-only check of the Vercel verifier** (GETs through the authenticated `vercel api`, nothing
  written):
  - `8d43150` → **verified** (`dpl_GjuUofuQEcYqMHdG3kfbTyoiPKz3`);
  - `ecc9ebb` → **rejected** ("domains on … (commit 8d43150), waiting for ecc9ebb").
- `actionlint` 1.7.7 (Docker `rhysd/actionlint:1.7.7`, `--network none`, read-only mount, with shellcheck),
  run on all workflows: **exit 0, no findings.**
- Prettier: the new scripts are formatted, and `deploy-production.yml` is clean. `ci.yml` is clean as
  stored in git; the working tree only differs by its CRLF line endings.
- The IDE warns "Context access might be invalid" for `RENDER_API_KEY`, `RENDER_SERVICE_ID_PRODUCTION` and
  `VERCEL_TOKEN`. That is expected until they exist, the same as the pre-existing `E2E_*` warnings.
- No app suites were re-run, because no app code changed.

**Pending cutover verification** (cannot be tested without a push or platform access):
- Render API behaviour with the real key, and that `ref` is honoured with `commit.id` reported. If it
  isn't, the job fails safe.
- How the 202 path behaves on this workspace.
- Vercel CLI `pull`/`build` from the repo root, honouring Root Directory `apps/web` in this pnpm monorepo.
- That `vercel deploy` prints only the URL on stdout.
- That `git.deploymentEnabled.main=false` at `apps/web/vercel.json` suppresses the Git production
  deployment while keeping PR previews.
- Whether a job waiting for approval holds the concurrency slot (still unverified, as in P42R).

## 9. Owner actions and blockers

1. Add `RENDER_API_KEY`, `RENDER_SERVICE_ID_PRODUCTION` and `VERCEL_TOKEN` to the `production` environment
   (§6.1). **This blocks pushing this commit.**
2. Confirm Render Auto-Deploy is off (§6.2).
3. Push, and watch the first run (§6.3).
4. Make the cutover commit (§6.4). Until then, **the production web is still published ungated by Vercel
   Git** (now verified per release, but not prevented).
5. Note: Vercel's Hobby plan is meant for non-commercial use. That is a billing or owner question; this
   task made no change.
6. `deploy-staging.yml` is unchanged, as in P42R §7.5.

## 10. P43R — fail-closed Render preflight

In P43 the Render service lookup ran only *after* migrations and the hook POST, and `autoDeploy: "yes"`
was only a warning. P43R makes it a gate:

- New step **Verify Render service and Auto-Deploy off (production)**
  (`deploy-rollout.mjs render-preflight`) runs right after the credentials check, **before** the Vercel
  build, migrations and the hook.
- It passes only when all of these hold:
  - `RENDER_SERVICE_ID_PRODUCTION` equals the pinned `RENDER_EXPECTED_SERVICE_ID`
    (`srv-d9cok48js32c73dss310`). This is checked before any API call.
  - `GET /v1/services/{id}` returns an object whose `id` is that service.
  - `repo` is this repository and `branch` is `main`. A missing value fails.
  - `autoDeploy` is exactly `"no"`.
- These all fail: `"yes"`, a missing or unrecognised value, a malformed body, 401/403/404 at once, and
  network errors or 5xx after 5 bounded retries.
- The setting is never changed by the workflow.
- `render` re-runs the same check immediately before the hook POST (the setting could change during
  migrations), and again while following the deploy.
- Tests: 30/30, using off/on/unknown/malformed/API-failure/identity cases, and a check that the hook is
  never POSTed when the preflight fails. Seven scratch mutations of the gate were all caught.

## Sources

- Vercel Deployment Checks: https://vercel.com/docs/deployment-checks, and the changelog https://vercel.com/changelog/block-vercel-deployment-promotions-with-github-actions
- Vercel Git configuration (`git.deploymentEnabled`): https://vercel.com/docs/project-configuration/git-configuration
- Vercel + GitHub Actions: https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel
- Vercel Get an Alias: https://vercel.com/docs/rest-api/aliases/get-an-alias
- Render deploy hooks: https://render.com/docs/deploy-hooks
- Render Retrieve deploy: https://api-docs.render.com/reference/retrieve-deploy

## 11. P43R2 — Vercel production cutover

Starting HEAD and `origin/main`: `182cb08a56091573c7b60a0d5a57c3a980399373` (P43R). The P43R run
([40672123296](https://github.com/cjlonzaga29-pixel/potato-corner-web-pos-main/actions/runs/40672123296))
was the first real test of the Render contract (§6.3). It passed: preflight `autoDeploy=no`, then
`dep-dbgt4b942hec73dvfc10` went from `build_in_progress` to live at `182cb08`, and the git-mode verify
found `dpl_CDcmEBeCGBu2q8cuLJ733xN5H4FA` at `182cb08`.

### 11.1 What the pre-cutover checks found

| Check | Result |
| --- | --- |
| `git.deploymentEnabled` semantics | The docs say it lists "branches that should not trigger a deployment upon commits", with minimatch keys and unspecified branches defaulting to `true`. So it affects **Git** deployments only, an exact `main` key leaves every other branch (PR previews) deploying, and explicit CLI deployments are unaffected. |
| `apps/web/vercel.json` location | The project's Root Directory is `apps/web` (`/v9/projects`). Vercel reads `vercel.json` there, and the CLI upload includes it. |
| **Local `vercel pull` + `vercel build --prod`** (CLI 59.11.7, repo root, pinned org/project ids) | **Failed: "Invalid rewrite found".** `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SOCKET_URL`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` are Vercel **Sensitive** env vars. `vercel pull` writes the literal `[SENSITIVE]` for them, so the `/api/:path*` rewrite destination was invalid. Had it not failed, the bundle would have shipped `[SENSITIVE]` as the Sentry DSN, PostHog key and socket URL. **The P43 prebuilt path cannot reproduce the Git build.** Making these vars readable would mean recreating values, which this task may not do. |
| CLI upload set (`vercel deploy --dry`) | From a working tree the CLI **ignores `.gitignore`**: 5,177 files and 235 MB, including `apps/api/.env`, `.turbo/cache` and local scratch folders. From a `git archive` export of the SHA: 1,432 files and 12.9 MB, only `*.example` env files, Next.js detected, `apps/web/vercel.json` included. |
| `vercel deploy` stdout | The docs say stdout "is always the Deployment URL". But in 59.11.7, `asJson = --format json \|\| client.nonInteractive`, and `nonInteractive` turns on when the CLI detects an AI agent or `--non-interactive`. So the shape depends on the caller. `--format=json` pins it: either `{id,url,target,readyState,…}` or `{status,deployment}`. |
| `vercel promote` | It is documented as the way to promote a *staged* production build (`--prod --skip-domain`), "instantly … it doesn't require a rebuild". In 59.11.7, a **non-production** id with `--yes` silently creates a new rebuilt deployment, and the command exits `0` on "No deployment promotion in progress". So the workflow never passes `--yes`, and it treats the alias check as the authority, not the exit code. |
| Token authority | The P43R verify step proved read access (aliases, deployments). No non-mutating endpoint was usable to prove deploy permission, so **the cutover run's staged deploy is the proof**. It runs before migrations, so a token without deploy rights fails with no production write. |

### 11.2 Workflow mode, as shipped (supersedes §4 steps 4 and 7)

1. After approval, the credentials check and the Render preflight, and **before migrations**:
   - `git archive $GITHUB_SHA` is extracted to `$RUNNER_TEMP/web-src`.
   - `vercel deploy --cwd <export> --prod --skip-domain --format=json --meta releaseSha=<sha> --meta releaseRun=<run id>`
     builds the release on Vercel with the real production env, the same builder as a Git build. **No
     domain is touched.**
   - `deploy-rollout.mjs vercel-staged` parses the JSON and accepts only one `dpl_…` id with target
     `production`. It then GETs the deployment and requires all of: the pinned project, `target:
     production`, `source: cli`, `meta.releaseSha == sha`, and `READY`.
2. Migrations, then Render (unchanged).
3. `vercel promote <that id> --timeout=5m`, with no `--yes`.
4. `vercel-verify` with `VERCEL_DEPLOYMENT_ID`: both domains must alias **exactly that id**, and the
   same own-deployment checks must pass (`source: cli`, `releaseSha`). A Git deployment, an older
   deployment of the same SHA, or another run's deployment can never satisfy it.

The publisher evidence does not rest on a username. Git deployments report `source: "git"`, and their
creator is the owner account, not a bot.

### 11.3 Cutover commit

- `apps/web/vercel.json`: `{"git":{"deploymentEnabled":{"main":false}}}`. `web-mode` returns `workflow`.
- `deploy-production.yml`: the staged-build and promote steps above replace `pull`/`build`/`deploy --prebuilt`.
- `deploy-rollout.mjs`: `parseVercelDeployOutput`, `assertOwnVercelDeployment` and `vercel-staged`;
  `vercel-verify` accepts `VERCEL_DEPLOYMENT_ID`.
- Tests: 33/33. They add the CLI JSON shapes, a bare URL, multi-URL/prose/foreign-host rejection, error
  status, a missing or malformed id, a non-production target, and `source`/`releaseSha`/project/READY/id
  mismatches on the staged deployment, plus token scrubbing. actionlint 1.7.7 with shellcheck: exit 0.

**Recovery.** If the staged build fails, nothing in production has changed: re-run after a fix. If promote
or verify fails after Render went live, production is the new API with the previous web (§7). Re-run the
failed job; it stages a fresh build and promotes it. To undo the cutover, revert this commit. Its revert
is then Git-published in git mode. If a promote has turned off "Auto-assign Custom Production Domains",
the git-mode verify times out (fail-safe), and the setting must be re-enabled before relying on git mode.

### 11.4 First cutover run: promote failed, fixed forward

[Run 40678105685](https://github.com/cjlonzaga29-pixel/potato-corner-web-pos-main/actions/runs/40678105685)
on `f27825a`:

- `validate` passed: 11:12:14Z to 11:18:53Z.
- The owner approved, and `deploy-production` started at 11:54:32Z.
- It logged `web publisher: workflow`, then the Render preflight `autoDeploy=no`.
- The staged build `dpl_92835WrMSFBPuiAb8N5L9mTAn1M8` was READY at 11:59:00Z, with `source: cli` and
  `releaseSha f27825a`. Both domains stayed on `dpl_CDcmEBeCGBu2q8cuLJ733xN5H4FA` (checked 11:59:32Z).
- The migrations were a no-op.
- Render deploy `dep-dbgu72utlv9c73ddd98g` was live at `f27825a` at 12:01:55Z.
- **`vercel promote` failed:** `Error: User not found. (404)`, 0.45 s after it started.
- Verify, the smoke tests and the release were all skipped. **Production was then the new API with the old
  web.** There was no compatibility risk: `182cb08` → `f27825a` changes no app code.
- Vercel created **no** Git deployment for `f27825a`. The staged CLI build was the only deployment.

**Cause.** In CLI 59.11.7, `promote` resolves scope through `getScope` → `getUser` (`/v2/user`). This
team token gets a 404 there. `deploy`, with `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` set, never makes that
lookup, which is why the staged deploy worked.

**Fix.** `deploy-rollout.mjs vercel-promote` calls the endpoint the CLI would call itself:
`POST /v10/projects/{projectId}/promote/{deploymentId}?teamId=…` (OpenAPI `requestPromote`: "does NOT
rebuild"; 201 means done, 202 means queued).
- Before the POST, it re-checks that the id is our own READY CLI production build of the SHA.
- It POSTs once and never retries.
- `vercel-verify` still decides the outcome.
- Tests: 35/35.

The orphaned staged deployment from the failed run is never promoted.
