# Current Handoff

This describes one branch and session, not every worktree. Check it against Git before relying on it. For where things
live, see [`PROJECT_MAP.md`](PROJECT_MAP.md).

**Concurrent sessions:** do not overwrite another session's handoff or invent its status. If sessions really are working
on different branches, keep one `docs/handoffs/<branch>.md` per branch and link them here.

## Observed state

- **Observed:** 2026-11-02
- **Branch:** `feat/pos-perf-p58-custom-product-types`. Local only: nothing pushed, merged or deployed.
- **Tested code:** `cd862cf`, on `3e0df7b`, `b9d3de4`. Local `origin/main` was `a92c587`; no fetch was run.
- **Docs:** the runbook, this handoff, `PROJECT_MAP.md` and `.claude/CLAUDE.md` are in one docs commit directly after `cd862cf`.
- **Working tree after that commit:** only `.vscode/settings.json` should remain modified. It is unrelated; never stage it with P58.
- **Other worktrees:** six older P51–P55R3 worktrees, all marked `prunable`. Nothing here authorizes removing them.

## Task status: P58 and P58R, verified locally

P58 custom product types and the P58R race fix are finished on this branch. See
[`runbooks/pos-perf-p58-custom-product-types.md`](runbooks/pos-perf-p58-custom-product-types.md), §11 for the evidence and limits.

**Remaining, each needing your go-ahead:** review, push, open a PR, CI, deployment. Run the read-only check in §11.7 before deploying.

## Read next

1. [`PROJECT_MAP.md`](PROJECT_MAP.md), "Products, builder, product types" section
2. Runbook §11, then §8 for overlap and rollback
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

**Needs separate authorization:** push, merge, PR, deployment, production access, branch switches, stashes, removing
worktrees, migrations outside a verified local database.

Record the code SHA that was actually observed or tested, never a guess at a future docs commit.
