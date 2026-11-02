# Current Handoff

This describes one branch and session, not every worktree. Check it against Git before relying on it. For where things
live, see [`PROJECT_MAP.md`](PROJECT_MAP.md).

**Concurrent sessions:** do not overwrite another session's handoff or invent its status. If sessions really are working
on different branches, keep one `docs/handoffs/<branch>.md` per branch and link them here.

## Observed state

- **Observed:** 2026-11-02
- **Branch:** `fix/pos-perf-p58-ever-published-test-isolation`, on `origin/main` `6931b10`, which merged PR #43 (P58/P58R).
- **Deployment:** run 41473432473's first attempt failed in `validate` on the test this branch fixes, so its production job was skipped. Failed jobs were re-run; check the run for its current state. Nothing here says P58 is deployed.
- **Tested code:** `cd862cf`, on `3e0df7b`, `b9d3de4`. Every commit after it changes docs only.
- **Docs:** the review, the rollout steps and the limitation triage are in a second docs commit after `8137321`.
- **Working tree after that commit:** only `.vscode/settings.json` should remain modified. It is unrelated; never stage it with P58.
- **Other worktrees:** six older P51–P55R3 worktrees, all marked `prunable`. Nothing here authorizes removing them.

## Task status: P58 and P58R, verified locally

P58 custom product types and the P58R race fix are finished on this branch. See
[`runbooks/pos-perf-p58-custom-product-types.md`](runbooks/pos-perf-p58-custom-product-types.md), §11 for the evidence and limits.

The pre-PR review changed no code (§11.9). Neither reported limitation blocks the release (§11.10).

**Test flake, fixed on this branch:** `products.ever-published.integration.test.ts` counted an item's stock rows at every branch, so a branch created by a parallel test file could fail it. Reproduced by simulating that branch creation. The count now covers the published branch only, and the test still fails if the stock write escapes the transaction.

**Remaining, each needing your go-ahead:** production approval, following the release steps in §8, including the read-only check in §11.7 before and after the deployment. Merging this branch starts a new production run, and an older run skips itself once a newer commit reaches `main`.

## Read next

1. [`PROJECT_MAP.md`](PROJECT_MAP.md), "Products, builder, product types" section
2. Runbook §8 for overlap, release steps and rollback, then §11 including the review in §11.9 and §11.10
3. `lockAndAssertMayEnable` in `apps/api/src/modules/products/products.service.ts`

## Verification evidence

All on local disposable databases, on `cd862cf`'s code.

| Check | Result |
| --- | --- |
| Race tests, real Postgres | 16 / 16 |
| Full API suite | 3,648 passed, 5 skipped, 0 failed |
| Full web suite | 1,627 passed, 0 failed. An earlier run under load had 12 timeouts (runbook §11.6) |
| Shared suite | 54 passed |
| Typecheck, lint, builds | Clean; 0 lint errors |
| Browser, service worker blocked | 53 / 53 |
| Browser, service worker active | 37 / 37. Ordinary Chromium, not an installed PWA |
| Physical camera, real devices, deployed cutover | **Not tested** |

## Known blockers and notes

- No blockers for review. Production was not accessed, and local Git says nothing about what is deployed.
- **Tax:** `.claude/CLAUDE.md` now separates the statutory PWD/Senior formula from `manual_total_v1`. No tax code changed.
- **Found, not changed:** `.env.example` calls `ENCRYPTION_KEY` hex, but the code decodes base64 (runbook §11.8).
- **Test setup:** the API environment needs a base64 `ENCRYPTION_KEY` and `TEST_REDIS_URL` set, or tests fail or skip.

## Actions

**Permitted:** read code; run local tests against disposable databases; update this handoff and the affected map entries.

**Needs separate authorization:** further pushes, merge, deployment, production access, branch switches, stashes,
removing worktrees, migrations outside a verified local database.

Record the code SHA that was actually observed or tested, never a guess at a future docs commit.
