# Account deletion and email reuse

Branch `feat/account-deletion-email-reuse`, rebased onto `e79487ae` (PR #50 merge). Released through a PR; see the PR for CI and deploy status.

## 1. Rule

Only a **permanent deletion** releases a login email. Deactivation (status Inactive) and the old P64 "removed but kept" state do not: the row still holds the email.

When an account is deleted, its users row, credentials, sessions, PINs and branch access go. The removed-account marker ends any token already issued. Its `people` record stays, so sales, refunds, expenses, attendance, payroll, stock movements, proofs and audit entries keep naming the original person.

A new account with the same email (any letter case) gets:
- a **new id** (the P66 trigger refuses reuse of a deleted id);
- only the access its own create grants, and fresh credentials;
- no old sessions, PIN or history.

## 2. Paths (traced)

| Path | Code | Status |
| --- | --- | --- |
| Supervisor and staff Delete | `employeesRepository.deletePermanently` (P66) | Already correct: row lock bound to the confirmed version, prerequisites rechecked under the lock, marker, `people` stamped, row deleted, all in one transaction. A repeat reports `already_deleted` |
| Branch login, normal branch Delete | `branchesRepository.deletePermanently` → `removeOperationalBranch` (P67) | Already correct. A shared login is kept |
| Branch login, Force Delete | `branch-force-deletion.repository` → `removeOperationalBranch` (P68) | Already correct. Email release is now tested (§4) |
| Leftover branch login (pre-P67) | `scripts/p68-leftover-branch-account-repair.ts`, exact ids only | Unchanged |
| Email conflict checks | `employeesRepository.findEmailHolder`, case-insensitive | Already used by Create Branch, Create Employee and the branch-account email edit |

## 3. Defect fixed

**Two simultaneous Create Employee requests with one email** (or a branch-account email edit racing a create):
- Both passed the case-insensitive pre-check.
- The database key `users_email_key` refused the second request, which then got a raw Prisma P2002 error, answered as a **500**.

Create Branch already mapped this error (P68); the employee paths did not. Now `employees.service.ts` `withEmailConflict` reports it as **409 `EMAIL_ALREADY_EXISTS`**. Emails are stored lowercase, so the key also catches case variants.

Proven: with the fix disabled, the new race test fails with `Unique constraint failed on the fields: (email)`.

## 4. Dialogs

Each dialog now says the email can be used for a new account, which starts fresh:
- Delete account: names the email; supervisors only, because staff have no login email.
- Delete Branch and Force Delete: shown when the branch has its own login.

The account dialog also says Inactive keeps the email.

## 5. Verification (local, disposable data)

| Check | Result |
| --- | --- |
| API integration on embedded Postgres: new `account-email-reuse` (7), P66 (15), P68 incl. new Force Delete reuse test (23), P47 (8) | Run 1: 1 failed, 4 skipped, from two bugs in my test (hook timeout, mixed-case fixture email). **Run 2: 53/53** |
| Same race test with the fix disabled | Fails (raw unique violation), as expected |
| Web: employee, branch and branch-ops component tests | **184/184** |
| Typecheck API and web / lint of changed files | Clean / 0 errors |
| Browser (`tests/e2e/manual/p70/email-reuse.mjs`), local P62 stack, production builds, SW active | Run 1 stopped on my selector bug. **Run 2: 11/11**: dialog copy; delete; recreate in capitals gives a new id with only the granted access, no PIN or sessions; history stays with the original person; duplicate refused; one holder |
| Leftover-repair wrapper rehearsal on the local stack (disposable data) | Diagnose → dry run → gates → execute: deleted; marker present; `people` stamped; audit entry written |

Pre-push full suites (2026-11-23, disposable local Postgres, run one after the other):

| Suite | Result |
|---|---|
| Type-check / lint (all packages) | exit 0 / exit 0 |
| Full API | 3,903 passed, 13 skipped, **1 failed file, exit 1**: `p60-expense-types` `beforeAll` hook timed out (10 s) under load, so its tests did not run. The file is untouched by this branch; known load-sensitive (P61, P62). Re-run alone: **32/32, exit 0**. Full API not re-run locally; CI runs it |
| Full web | **1,836/1,836, 194 files, exit 0** |

**Not run:** real devices, a hosted environment.

## 6. Limitations

- **No `lower(email)` unique index.** Same reason as P68: production may hold legacy case duplicates. Normalized storage plus the existing key cover new writes.
- **Other processes' caches (as P68):** another API instance can accept a deleted account's token for up to 60 s. Its writes are still refused by the database.
