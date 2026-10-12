# POS-PERF-P34R3 — Final Web Suite Check

## Starting / final state

- Starting local HEAD: `1f6181a9682ca7385e8c9e36f165694d2fbb016d` (`fix(pos-perf-p34r2): harden integration-test cleanup, final workflow verification`), 3 commits ahead of `origin/main`, clean working tree.
- Final local HEAD: unchanged — no source or test code required a change (see below). 3 commits ahead of `origin/main`, nothing pushed.
- Machine: 2 physical cores / 4 logical processors. Several pre-existing, unrelated dev processes were already running for the whole task (an API `tsx watch` dev server with 4 duplicate instances, a Next.js dev server on port 3000, a Playwright test-server) — none were started or stopped by this task.

## 1 — Full `apps/web` suite, controlled concurrency

Ran `vitest run --poolOptions.threads.maxThreads=2 --poolOptions.threads.minThreads=1` (capped below the 4 logical processors to leave headroom for the pre-existing dev processes above):

```
Test Files  2 failed | 136 passed (138)
     Tests  2 failed | 1222 passed (1224)
Duration    561.14s
```

Both failures were `Error: Test timed out in 5000ms`:
- `components/branch-ops/inventory-adjust-form.test.tsx` — "keeps submit disabled until evidence is uploaded, then saves immediately with no verification_token"
- `app/(supervisor)/supervisor/reports/page.test.tsx` — "renders a transaction row on the Sold Product Transactions tab"

## 2 — Investigating the failures (not assumed to be contention)

Per instruction, an isolated-run pass alone was not treated as proof of contention. Each failing test was read in full first:

- `inventory-adjust-form.test.tsx`'s failing test does a real `fireEvent`-driven flow (select item, type quantity, upload evidence file via a mocked `useUploadInventoryEvidence`, submit, confirm in an `alertdialog`) — no real timers, no network, no polling loop that could legitimately hang. Nothing in the test or the component (`InventoryAdjustForm`) does unbounded async work.
- `supervisor/reports/page.test.tsx`'s failing test renders the page with fully mocked query hooks and asserts a transaction row appears — same shape, no real async dependency.

Both were run alone and passed well under the timeout (2216ms and 323ms respectively) — consistent with, but not sufficient proof of, contention per the task's own standard.

**Stronger evidence gathered:** the full suite was re-run with `--poolOptions.threads.singleThread=true` (serial execution, one worker, zero intra-suite parallelism) while the same pre-existing external dev processes were still running:

```
Test Files  138 passed (138)
     Tests  1224 passed (1224)
Duration    155.20s
```

This is the decisive data point, not just "isolated file passes": with zero intra-suite contention the *entire* suite, including both previously-timing-out tests, passed cleanly and the whole run finished in 155s versus 561s for the 2-worker run — a 3.6x wall-clock difference despite running strictly more serialized work. That gap is explained by thread/CPU scheduling overhead on a 2-core/4-thread box that was also running an API dev server (4 duplicate `tsx watch` instances), a Next dev server, and a Playwright test-server the whole time — not by anything in the two test files. No defect was found in either test or its component; no code change was made.

## 3 — Other checks

Per the task's "do not repeat completed checks unnecessarily," since no source change was made in this session, the build/typecheck/lint passes already recorded clean in `pos-perf-p34r2-final-verification.md` Part 4 were not re-run.

## 4 — Result

| Check | Result |
|---|---|
| `apps/web` full suite, 2-worker concurrency | 136/138 files passed, 1222/1224 tests passed (2 timeouts) |
| Root-cause investigation of the 2 timeouts | No application or test defect — thread-scheduling contention from pre-existing external dev processes on a 2-core machine, confirmed via a clean single-threaded full-suite run (138/138, 1224/1224, faster wall-clock despite serialization) |
| `apps/web` full suite, single-thread (serial) | 138/138 files, 1224/1224 tests, exit 0 |

**No release blocker.** No test or source code was weakened, skipped, or modified to reach this result — the full suite passes deterministically once intra-suite thread contention is removed, and the specific two tests that timed out under 2-worker concurrency contain no async hazard of their own.

## 5 — Limitations

- This machine is resource-constrained (2 cores) relative to typical CI runners; the 2-worker timing-sensitivity observed here may not reproduce on CI hardware with more headroom, and conversely CI could show the same symptom if it schedules this suite alongside other heavy jobs. If CI ever shows these same two tests timing out, re-check for genuine regressions before assuming contention again — this writeup is evidence for *this specific run*, not a blanket excuse.
- No push, deploy, migration, or production-data action was taken in this task.
