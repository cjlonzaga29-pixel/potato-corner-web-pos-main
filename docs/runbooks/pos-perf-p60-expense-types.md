# POS performance P60: Supervisor-created Expense Types

**Status:** verified locally. Not pushed, no PR, not deployed. Production was not accessed.

| | |
| --- | --- |
| Branch | `feat/pos-perf-p60-expense-types` |
| Starting SHA | `6794333`, the tip of unpushed P59 |
| Tested code | `6694e05` |
| Migrations | `20261104120000_pos_perf_p60_expense_types`, `20261104120100_pos_perf_p60_validate_expense_type_fk` |

**P60 depends on P59.** This branch was cut from the P59 tip on purpose, because P60 reuses P59's export coverage and PDF cap. Merging it brings in all of P59, including its owner decisions and open blockers (section 8).

Supervisors create expense types for their branches and use them to sort expenses into filtered views. There is still one ledger. A type is only a label: Employee Expenses or Product Purchases have no payroll or stock effect, and no expense moves cash automatically. No dashboard, example type or expense was added.

## 1. Who can do what

| Role | Types | Expenses |
| --- | --- | --- |
| Supervisor | Create, edit, deactivate and reactivate, within the rules below | Create and read in assigned branches. Edit through the API only, with no screen |
| Branch account | Read | Create and read in its own branch. Edit through the API only, with no screen |
| Super Admin | Read only | Read, edit and delete across all branches |

**Scope, checked against live assignments:**

- **Full cover:** a Supervisor can change a type only if their assignments cover its whole scope.
- **Partial overlap:** they can use the type but not change it.
- **No overlap:** the type returns 404, as if absent.
- **Other branches:** their names stay hidden. The response carries only `other_branch_count`.

**Names:**

- Compared after normalizing case and spacing, and unique among active types within a branch. A partial unique index on `expense_type_branches` enforces this, so a race can't get past it.
- The reserved names All, All Expenses, Legacy and Unassigned are refused, because they would look like the built-in cards.
- A name freed by a rename or deactivation can be reused. Reactivating into a name now taken is refused.

**Changing a type's branches:**

- A branch can always be added.
- A branch can be removed only while no expense at that branch has ever used the type, soft-deleted ones included. Otherwise the API returns `EXPENSE_TYPE_SCOPE_IN_USE`. The check runs in the same transaction, after the type's row lock is held.

**Concurrency and audit:** edits use a version check, so a stale edit gets a 409. The audit actions are `EXPENSE_TYPE_CREATED`, `_UPDATED`, `_DEACTIVATED`, `_REACTIVATED` and `_SCOPE_CHANGED`.

## 2. Saving and editing an expense

- **One save per attempt.** The idempotency key is reserved in the same transaction as the expense. A retry after a lost reply returns the saved expense, and the same key with different details returns `EXPENSE_KEY_REUSED` (409). A refused attempt leaves no key behind.
- **Proof paths are made by the server,** under the expense. A failed upload keeps the expense and offers a retry.
- **Editing without changing the type or branch** doesn't re-check them, so an expense under a deactivated type stays editable and keeps its name.
- **Changing the type or moving the branch** re-validates in the transaction.
- **Legacy to typed** is allowed through `PATCH`: it keeps the category and records the name. There is no screen for it (section 7).
- **Changing the category of a typed expense** returns 409 `EXPENSE_CATEGORY_NOT_EDITABLE`. Resending the same value is fine.

## 3. Historical identity and categories

- **No backfill.** Every existing expense stays legacy, shown as "X (legacy)" and grouped under the Legacy / Unassigned card. Types are never guessed from the vendor or description.
- **Recorded name.** `expense_type_name` holds the name at save time. A rename rewrites no history: the row shows the recorded name and "now called X", and navigation uses the current name.
- **Deactivating a type** keeps its card (marked), its ledger and its totals. New expenses can't pick it.
- **The category column stays `NOT NULL`, and no enum value was added.** Typed rows store the placeholder `miscellaneous` (`EXPENSE_TYPED_CATEGORY`) so an old API can still read them. The placeholder never appears as a real category: category and unassigned filters match only rows with no type.
- **Consistency.** A database check requires `expense_type_id` and `expense_type_name` to be both set or both null. The foreign key is `RESTRICT`, while branch scope rows cascade, so permanent branch deletion keeps working.

## 4. Ledger, dashboards and reports

**One ledger, filtered views.** The All Expenses card holds everything. Each type has its own card, with count and total from `GET /api/expenses/summary`, not from the rows on the page. Many types stay in a bounded board that scrolls within itself (tested with 26).

| Surface | What it gets |
| --- | --- |
| Supervisor and Branch expenses | Type cards, date filters, pagination, server export, Add Expense preselecting the open type |
| Supervisor dashboard, Admin dashboard, Admin Reports | A type breakdown whose total matches the KPI beside it and drills through to the filtered ledger |
| Admin expenses | Server CSV, type filter (deactivated types marked), total shown as "—" until loaded rather than a false ₱0 |
| Exports, all roles | `EXPENSES` server CSV and PDF, with `expense_type` and `current_type_name` columns |

**Export limits, using P59's coverage rules:** PDF 100 rows, CSV 10,000. A PDF past the limit says `PARTIAL EXPORT` inside and in its file name, while its summary keeps the full count and total. There is no default 7-day window. Admin Reports and the Admin ledger now use these exports, so a CSV no longer holds only the page on screen.

**Bugs found and fixed in existing behaviour.** These predate P60, so a deployed build probably has them. That was not checked.

- `GET /api/expenses?branch_id=` overrode the caller's branch scope, allowing a **cross-branch read**. It now returns 403.
- `PATCH` could move an expense to a branch outside the caller's scope.
- List date filters were ignored (`date_from` against `dateFrom`).
- An idempotent replay was returned before the access check. The key was also racy, not atomic with the expense, and generated per call by the client.
- Rows with tied dates could repeat or vanish across pages. The order is now `incurredAt`, `createdAt`, `id`.
- `ExpensesView` had no pagination, and switching branch could briefly show the previous branch's rows.

## 5. Migration rehearsal and compatibility

`apps/api/scripts/test-p60-migration-on-populated-data.ts` **passed** on a disposable database with 20,000 expenses and 2,000 sales:

- 85 existing tables were byte-identical afterwards, and totals were unchanged.
- No type was guessed or seeded.
- The new constraints refuse bad rows, including reactivating into a taken name.
- `prisma migrate diff` found no drift.

Both migrations are additive. The foreign key and check are added `NOT VALID` and validated in the second migration.

| Mix | Behaviour | How known |
| --- | --- | --- |
| Old client, new API, `category` and no type | Saved as an explicit legacy expense under that category | API tests |
| Any client, new API, neither field | 422 "Choose an expense type" | API tests |
| Any client, new API, both fields | 422 | API tests |
| Old API, migrated database | Ignores the new columns and reads typed rows as `miscellaneous`. Totals hold; type names don't show | Raw SQL only. **No old API process was run** |
| New web, old API | `/api/expense-types` 404, so Save is disabled and nothing is written. Breakdown shows "unavailable". CSV returns 400 `UNSUPPORTED_FORMAT` | **Read from code, not run** |

A branch with no types can't record an expense in the new web until a type exists. A Supervisor is offered Create Expense Type, and a branch account is told to ask its Supervisor. **Tell Supervisors before rollout, because branch accounts can't save expenses until then.**

## 6. Verification

Sequential, on disposable local databases, with throwaway secrets and real local Supabase Storage. The services and browser profiles from this run have been stopped and removed.

| Check | Result |
| --- | --- |
| Full API suite, real Postgres, final code | **3,733 passed, 5 skipped, 0 failed** (221 files passed, 1 skipped) |
| Shared suite | 83 passed |
| Full web suite | 1,670 passed, 0 failed (179 files) |
| Typecheck | API and web, 0 errors |
| Lint | 0 errors; API 403 warnings (6 from the rehearsal script), web 1 warning (origin not checked) |
| Production builds | API and web pass |
| Migration rehearsal | Pass |
| Browser, Chromium, final builds, service worker active | **86 / 86** on a complete run from fresh data |
| Second browser run for checks the first read too early or from cache | **11 / 11**; service workers blocked for its first part only |
| Generated CSV and PDF files | CSV parsed; PDF text extracted. PDF appearance not inspected |

Only `p60-expense-types.integration.test.ts` changed after the web checks and browser runs. The full API run covers it, and that file was typechecked and linted again on its own.

**Browser coverage:**

- Legacy history, type creation, duplicate refusal, a lost reply and a double click saving once, and a failed upload then retry
- Proof loading through a signed URL
- Rename and deactivate keeping history, and a stale edit refused
- Totals checked against the database on the ledger, dashboards and exports, with drill-through
- Foreign branch and type requests refused
- A branch load showing nothing from the previous branch, with "Loading total…" rather than ₱0
- A real 150-row export: PDF of 100 rows marked partial, with the summary still 150 and ₱2,267.00, and a CSV of 151 lines
- Tablet (768×1024) and phone (390×844) layouts, by Playwright emulation

### Failures on the way

| Run | Result | Cause |
| --- | --- | --- |
| First full API run, before the final code | **1 failed test, 1 failed suite**, 3,720 passed, 17 skipped | See below |
| First full web run | 57 failed in 5 files | Mocks written for the old screens; tests updated |
| Browser runs 1 and 2 | 27 / 45 twice | Driver: wrong branch, date SQL |
| Browser run 3 | 50 / 62 | Driver: timing, proof Confirm button |
| Browser run 4 | 59 / 65 | Driver pace tripped the rate limiter (429). Slowed down, limiter left on |
| Browser run 5 | 76 / 78 | **Real bug:** renaming a type during the first load left stale rows. Fixed with `cancelQueries` before invalidating |
| Second-run script attempts | Partial | Script faults: no held calls, a stale refresh token, a mangled ₱ in the script. Fixed, then re-run in full |

**The first API failures were not proved to be understood.** The clean final run shows they did not recur, not what caused them:

- `flavors.integration.test.ts` ("updateFlavor reactivation"): probably the new test's real branch hard-delete racing other tests' provisioning. That test now rolls the delete back in a transaction.
- `p57-mix-max-shortages.integration.test.ts`: `beforeAll` hit its 10s timeout, presumably from load.

The embedded test Postgres also hung on shutdown after its tests had finished, so the full suite ran on a disposable Docker Postgres instead.

## 7. Limitations

**Not tested:**

- Real devices, physical camera (gallery upload used) and printing
- Hosted Storage and production volume
- Offline use
- Mixed old and new versions running live
- Realtime dashboard updates: the socket badge read "Disconnected" on this local setup

**Known gaps:**

- No Supervisor screen for editing an expense or moving legacy rows to a type. The API supports it.
- A type scoped to a since-inactive branch can't be managed by Supervisors. This is consistent with P58.
- A drill-through link for a branch other than the active one drops its filters, with the branch shown in the header.
- The active branch persists only per session.
- Long type names are cut off on phone cards. Tapping the card shows the full name.

**Found, not changed:**

- `uploadReceipt` removes the old object before the new upload succeeds.
- The service worker's `apis` cache stores `/api` GETs (NetworkFirst).
- A revoked session stays on the dashboard with repeated 401s until it redirects.
- `GET /api/reports/daily-sales` returned 400 in one browser run. Not investigated.

## 8. Rollout and rollback

**Rollout order:** migrations, then API, then web. Each needs its own authorization. P59's own rollout notes apply too, since it ships with this branch.

**Rollback:** code only. Roll back web, then API. **Do not drop the new tables or columns or rewrite migration history.** An old API can read the rows, and they keep the type data for a later roll-forward.

- **What an old API can't do:** show type names. Typed rows appear under `miscellaneous`, and totals are preserved. Decide whether that's acceptable before any rollback that follows real use.
- **Not rehearsed with a real old process:** see section 5.

**Still open from P59, and release blockers:**

- **PDF rendering blocks the API thread.** A 100-row PDF stalled checkout for about 2s on a laptop. P60's expense PDFs add another route with this cost.
- **The Transaction PDF route and Admin's synchronous PDFs are uncapped** below 2,000 rows.
- **P59 owner decisions** are still to confirm: receipts without VAT lines, exports without VAT columns, and no VAT registration screen.

See `pos-perf-p59-reports-and-ui-cleanup.md`. P60 was explicitly not asked to fix these.

**Next:** Extra Supplies setup, terminal, and inventory and history integration. Performance and PDF isolation stay last, before release.
