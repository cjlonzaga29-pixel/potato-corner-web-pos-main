# POS-PERF-P68: branch email reuse, Force Delete Branch, branch-scoped staff

Branch `feat/pos-perf-p68-branch-lifecycle-and-staff`, from `origin/main` `365758c4` (PR #48 merge, the last **reported** deployment, not verified here). Local only: nothing pushed, merged or deployed, production not accessed, and **no production cleanup run**.

## 1. Causes (traced and reproduced locally)

### A. "An account with this email already exists" for a branch the owner can't see

- Create Branch checked `users.email` across every role and state (`findByEmail`, exact match).
- **Most likely cause: a leftover branch login from a branch deleted before P67.** The old Delete cascaded `user_branch_assignments` but left the role `branch` `users` row and its email behind. No screen lists such an account:
  - Branch Accounts shows only live assignments.
  - The Employees directory excludes role `branch`.
  - Employee Delete refuses branch accounts.
- P67's `findBranchAccountIds` needs an assignment row, so it can't find these accounts either.
- Reproduced in `p68-branch-lifecycle.integration.test.ts`: a role `branch` user with no assignment blocks the email.
- Other holders the old message didn't distinguish:
  - a supervisor or admin with that email;
  - a P64 "removed but kept" row (`deleted_at` set);
  - a branch login shared with another live branch.
- **Not checked against production:** which of these applies to the screenshot. A dry-run diagnosis (§2) shows it.
- **Also found:** two concurrent creates with the same email both passed the pre-check. The loser hit `users_email_key` (P2002, whole transaction rolled back, no partial branch) and returned a generic **500**.
- **Also found:** the check was case-sensitive, so a legacy mixed-case email could be duplicated by case.

### C. Rows without PIN, Edit or Delete controls

These rows were **supervisor accounts**, not staff.
- The supervisor Employees list asked the API for staff and supervisors, then hid every action on non-staff rows (the server refuses those changes anyway).
- **New branch:** the only people assigned to it were its supervisor(s), so their rows showed no controls.
- **Demo, two same-name rows:** two distinct accounts, one supervisor and one staff, with the same name. The list is one row per account. Not merged or deleted (owner decision; it may hold PIN, sales or attendance).
- **Ruled out:**
  - The list was already branch-filtered on the server.
  - Branch login accounts were already excluded.
  - Create already sent exactly one branch.
- **Smaller gaps fixed:**
  - Supervisors' Create dialog offered every branch the list endpoint returned. The server refused out-of-scope branches either way.
  - The total was not shown.
  - The total of a previous branch could show while a branch switch was loading.

## 2. Email reuse and historical identity (A)

- **Classified, field-specific conflicts** (`branches.service.ts` `assertBranchLoginEmailAvailable`). Each is returned with `details.field = 'account.email'` and shown beside Username, keeping every typed value:
  - `EMAIL_ALREADY_EXISTS`: a working account holds it. Names the holder's role.
  - `EMAIL_HELD_BY_LEFTOVER_ACCOUNT`: a role `branch` account with no live assignment, or P64-removed. Gives the **exact account id**.
  - `EMAIL_HELD_BY_REMOVED_ACCOUNT`: a P64-removed non-branch account.
- **Comparison is case-insensitive** (`employeesRepository.findEmailHolder`). It is used by Create Branch, Create Employee and the branch-account email edit. No database index was added, because a `lower(email)` unique index could fail on existing duplicates. Check production first.
- **A concurrent same-email create** now gets 409 `EMAIL_ALREADY_EXISTS` ("created at the same moment"). Exactly one branch and one account result (tested).
- **No automatic deletion.** An account is never removed because its branch is missing. Shared logins (assigned to another live branch) are kept on deletion, as in P67 (tested).
- **Normal and Force Delete** both use `removeOperationalBranch` (shared, P67 lifecycle):
  - The exclusive login account is physically deleted.
  - The removed-account marker kills its tokens.
  - `people` keeps attribution.
  - After that the email is free. A new account gets a **new id**: the P66 trigger refuses reuse of a deleted id. It gets no old sessions, permissions, assignments or history (tested).
- **`people` and `branch_records` hold no email**, so a historical snapshot never reserves a login.

**Leftover repair, dry run first, exact ids only** (`apps/api/scripts/p68-leftover-branch-account-repair.ts`, lib `branches/leftover-branch-account-repair.ts`):

1. Diagnose (read-only):

   ```
   npx tsx scripts/p68-leftover-branch-account-repair.ts --diagnose --database-host <host>
   ```

   It lists every role `branch` user with no live assignment, with:
   - its assignment rows;
   - the `BRANCH_ACCOUNT_CREATED` audit entry;
   - the historical branch record it names (name, code, `deleted_at`).

2. A person reviews each one and writes a manifest: `{ actor_user_id, accounts: [{ id, email, evidence }] }`. Don't use email patterns.

3. Dry run with `--manifest`. It prints a token bound to the manifest text and database host.

4. Execute with `--execute --confirm <token>`. Each account is re-read under its row lock and deleted only if all of these still hold:
   - it is still role `branch`;
   - it has the same email (case-insensitive);
   - it has no live assignment;
   - it has no open shift or clock-in.

   Otherwise it is refused (tested: live, shared, supervisor, wrong email). Each deletion is audited `LEFTOVER_BRANCH_ACCOUNT_DELETED`.

**Production diagnosis, dry run and execution: NOT run.** They need the owner's review.

## 3. Force Delete Branch (B)

Normal Delete is unchanged: it still blocks on open work. **Force Delete** is a separate Super Admin action, offered from the blocked Delete dialog as **Force Delete Branch…**. Routes:
- `GET /api/branches/:id/force-deletion-plan`
- `POST /api/branches/:id/force-delete`
- `GET /api/branches/force-deletions/:operationId`
- `POST /api/branches/force-deletions/:operationId/abort`

All are `adminOnly` in the router and checked again in the service. There is no `force=true` flag on the normal route.

### 3.1 Confirmation

- **The plan lists every open item by exact id.** The dialog shows:
  - counts per kind, with what happens to each (§3.3);
  - examples;
  - kept history and removed configuration;
  - the offline limit (§3.6).
- **The confirmation must match all of these:**
  - the typed name (case and spaces ignored) and the exact code;
  - the acknowledgment (`acknowledge: true`, Zod literal);
  - the `version` (the branch's `updated_at`);
  - `plan_keys` with `plan_hash`;
  - `confirmation_token = HMAC(HASH_KEY, actor | branch | version | plan_hash)`, so it binds the actor, the branch, the mode, the version and the exact plan.
- **Refusals:**
  - wrong text: `DELETE_CONFIRMATION_MISMATCH`, 400;
  - another admin's token or an altered plan: `DELETE_CONFIRMATION_INVALID`, 403;
  - an edit since: `BRANCH_CHANGED`, 409;
  - open work that is not in the confirmed plan: `FORCE_DELETION_PLAN_CHANGED`, 409, with nothing changed.
- **Stock keys include the quantities**, so a changed balance counts as new.
- **Cancel sends nothing.**

### 3.2 Lifecycle (durable, idempotent)

Table `branch_deletion_operations`. The id is the client's operation id. Status is `fenced`, then `completed`, `aborted` or `failed`. A partial unique index allows one fenced operation per branch.

1. **Fence** (transaction 1):
   - Set `branches.deletion_fenced_at` and `deletion_operation_id`, bound to the version, and create the operation.
   - The live-branch trigger (P67 function, replaced in the P68 migration) now locks the branch row **FOR SHARE**. The fence UPDATE therefore waits for every guarded write already in flight, and every later write is refused. The guarded writes are sales, stock movements, shifts, clock-ins, expenses, Extra Supplies, payroll, and now **hold_orders** and **checkout_attempts**.
   - The refusal is SQLSTATE P0001 `POS_PERF_P68_BRANCH_DELETION_IN_PROGRESS`, mapped to 409 `BRANCH_DELETION_IN_PROGRESS`. It is retryable, because the operation can still be aborted.
   - Branch edits and status changes are refused with `BRANCH_DELETION_IN_PROGRESS`, and normal Delete with `BRANCH_CHANGED`.
2. **Finalize** (transaction 2, nothing external inside, 60 s budget):
   - Take the operation row lock. Concurrent drivers (a retry, a status poll, the sweeper) serialize here.
   - Re-read the plan. If any item is new or changed, the operation is aborted, the fence is lifted, and it is audited `BRANCH_FORCE_DELETION_ABORTED`.
   - Otherwise every item gets its explicit outcome (§3.3) and a closure item.
   - Then the shared P67 removal runs: exclusive branch accounts, notifications, report snapshots, `branch_records.deleted_by`, and the branches row.
3. **After commit:**
   - Socket sign-out of the branch accounts, room leave, `BRANCH_DELETED`.
   - Audit `BRANCH_FORCE_DELETED`, with closure-item counts per kind, removed counts and deleted account ids.
   - Post-commit failures are logged only.

**Retries:**
- A repeat with the same operation id returns that operation's status, finishing it if it is still fenced.
- An operation id used for another branch or by another actor gets `FORCE_DELETION_OPERATION_CONFLICT` (tested).
- An inconsistency or unexpected error keeps the operation **fenced**, with `last_error` and step `retry_pending`. It is never reported complete.
- `startForceDeletionSweeper` (in `server.ts`, at start-up and every 30 s) resumes fenced operations after a crash or restart (tested by fencing directly, then advancing).
- The dialog:
  - keeps its operation id in `sessionStorage`, so a reload shows the same operation;
  - after a lost response, asks about that exact id before showing an error;
  - polls every 2 s while the operation is fenced;
  - offers **Stop and keep the branch** (abort).

### 3.3 Outcomes: nothing fabricated, nothing silently destroyed

| Open item | Outcome | What is NOT done |
| --- | --- | --- |
| Open shift | `status = 'terminated'` (new enum value), `terminated_at`, `termination_operation_id` | No cash count. `closed_at`, `closed_by` and the closing amounts stay null. Never "closed" or reconciled |
| Open clock-in | `administratively_terminated_at` and `termination_operation_id` (new columns) | No clock-out time, work minutes or pay. Excluded from "open" readers so the person can clock in elsewhere, and from payroll (which needs a clock-out) |
| In-progress checkout | `abandoned`, once proved uncommitted: no linked sale. After the fence none can be inserted | No sale invented. A linked sale makes the item an **inconsistency** and the operation stays fenced |
| Deduction job (pending, processing or failed) | `cancelled`, claim token cleared, once proved unapplied: no stock movement references its sale | The sale stays. If movements exist, it is an **inconsistency** (fenced, reported) |
| Projection outbox row | `stuck`, for manual review | The movement stays |
| Pending or returned approval | `CANCELLED` (the existing P28R2 terminal state), with canceller and reason | No stock applied |
| Held order (with its lines) | Snapshot kept in its closure item. The row is removed with the branch (it was configuration-level CASCADE) | No payment existed |
| Stock on hand or reserved | Snapshot of on-hand, reserved and item name. The `inventory_stocks` row goes with the branch | **No zeroing, transfer or write-off movement.** The ledger is untouched. Other branches' balances and transfer history are untouched |
| Draft payroll run | Stays `draft` (read-only afterwards) | Not finalized. Finalized snapshots are untouched |
| Hours no finalized run covers | Listed per attendance row | Not paid or changed |

- Posted sales, payments, expenses, supply issues, proofs and all P67 history stay on `branch_records`.
- A claimed worker can't commit afterwards:
  - its stock write is refused by the fence (tested);
  - its compare-and-swap on the job fails because the claim token is cleared.
- **Not covered by a fixture:** pending inventory approvals. The path is code-reviewed only and has no integration test.

### 3.4 Unresolved items stay visible and reconcilable

- `branch_closure_items` is durable and read-only. Each row records:
  - kind, source table and id, outcome and reason;
  - a snapshot;
  - the recording actor and time.
- A trigger refuses edits and deletes. Only the reconciliation fields can be set, once.
- **Admin → Branches → Deleted-branch items** (`/admin/branches/closure-items`) lists Unresolved and Reconciled items. **Mark reconciled** records a note, the actor and the time (audited `BRANCH_CLOSURE_ITEM_RECONCILED`).
- The original records are never changed there. Settlement (counting cash, paying hours, moving stock) happens outside the app and is recorded here.

### 3.5 Blockers not treated

None are bypassed. The following stop a Force Delete and leave it fenced with a precise message:
- an in-progress checkout already linked to a sale;
- a deduction job whose sale already has stock movements.

Both indicate inconsistent state that needs a person.

### 3.6 Offline terminals

- **The server cannot inspect or delete queues stored on offline terminals. Force Delete does not erase offline data.**
- A queued sale that syncs later is refused:
  - the batch, because the token no longer grants the branch, so rows stay with `lastError`;
  - or the item, with `BRANCH_DELETED`, now a definitive local refusal: kept, visibly refused, never resent automatically.
- Rows are keyed by the original branch id, so they are never sent to a new branch that reuses the name or email.
- A fenced-branch refusal (`BRANCH_DELETION_IN_PROGRESS`) stays retryable.
- Reconcile such sales by hand against the closure record.

## 4. Branch-specific staff and PIN (C)

- **Employees list** (`branch-ops/employees-list.tsx`):
  - It asks the server for `role=staff` in the selected branch. The server checks branch access, counts the same set and searches server-side. Rows are filtered client-side again (staff only, assigned to the active branch).
  - Supervisor and branch accounts no longer appear as incomplete rows. They stay in Branch management and Branch Accounts.
  - The total shows "N staff members" and is hidden while a switch is loading (`isPlaceholderData`), so another branch's rows or count never flash.
  - The query key already contains the branch, role and search.
- **Create Employee:**
  - The default is the selected branch, with exactly one branch (shared schema).
  - Only a Super Admin sees every branch. A supervisor or branch account sees only the branches its token grants. The server already refused others, with 400.
  - New staff appear immediately (`['employees']` invalidated) with **No PIN** and **Set PIN**.
- **Actions:** PIN Set/Reset, Edit, Status and Delete render for staff rows. Each server action re-checks branch access (`assertCanManageTarget`, `staffPinService` scope). Tested: a supervisor whose access to a branch was removed can no longer list it or set a PIN there. The PIN is never returned; only `has_pin`/`is_active`.
- **PIN rules are unchanged:** 4-6 digits, unique per branch (`PIN_ALREADY_IN_USE`), with verification rate limits.
- **Multi-branch staff:** the server already requires exactly one branch for staff on create and edit. No existing assignment is changed or removed. Supervisors may hold several branches, and are listed only in their management areas.
- **Duplicates:** rows are keyed by account id. Same-name staff in A and B are separate accounts with separate PINs (tested). Nothing is merged or deleted automatically.

## 5. Migration, compatibility, rollback

**Migration** `20261123120000_pos_perf_p68_branch_force_deletion` (new; no applied migration edited):
- `ShiftStatus` gains `terminated`.
- New tables `branch_deletion_operations` and `branch_closure_items` (immutability trigger).
- Nullable columns on `branches` (`deletion_fenced_at`, `deletion_operation_id`), `shifts` (`terminated_at`, `termination_operation_id`) and `attendance_records` (`administratively_terminated_at`, `termination_operation_id`).
- `pos_perf_p67_assert_live_branch` replaced (adds the fence check and uses FOR SHARE).
- Guard triggers on `hold_orders` and `checkout_attempts`.
- No row changed, nothing deleted, no cleanup.

**Rehearsal** (`scripts/test-p68-migration-on-populated-data.ts`): 302 branches, 20,000 sales, an open shift and clock-in, a P67-deleted branch and a leftover login.
- Run 1: a seed SQL bug in the script (`shifts` has no `updated_at`).
- **Run 2 passed:**
  - all 94 pre-existing tables are byte-identical in their pre-existing columns;
  - no operation, fence or termination exists;
  - the leftover is untouched;
  - the guards behave;
  - closure items are immutable;
  - one fenced operation per branch;
  - **no drift**.

**Lock change:** guarded writes now take FOR SHARE on the branch row, instead of FOR KEY SHARE. A branch edit (Prisma UPDATE) now waits for in-flight guarded writes of that branch, and the reverse. This is the intended serialization for the fence. Branch edits are rare; no deadlock path was found or tested under load.

**Order:** migration, then API, then web.

**Mixed versions:**
- *Migration with an old (P67) API:* reads and writes work. No old code sets the fence. Old writes for hold orders and checkouts at a deleted branch now get a trigger refusal instead of an FK error (still refused).
- *New API with an old web:* there is no Force Delete UI. The old supervisor list still shows supervisor rows. The old Create Branch shows the new messages as a toast.
- **No Force Delete until every API instance runs P68.** An old API doesn't know the fence (normal Delete or edits of a fenced branch) or `ShiftStatus.terminated`. This is documented, not database-enforced.

**Rollback floor:**
- Before the first Force Delete, the API can go back to P67.
- **After any Force Delete, P68 is the floor.** Older Prisma clients fail on `ShiftStatus 'terminated'` rows, and older open-attendance readers would treat terminated clock-ins as still open.
- Never drop the new tables, columns or triggers once used.

## 6. Verification

Run on fresh disposable embedded Postgres (ports 46871/46872), sequentially, with the throwaway env `C:\p68\env.sh`. Never production.

| Check | Result |
| --- | --- |
| Focused API (branches module, employees service, P66/P67/P68 integration), run 1 | 2 failed, 287 passed: two repository unit tests asserting the exact open-attendance `where` shape changed by P68. Assertions updated |
| P68 integration (`p68-branch-lifecycle.integration.test.ts`) | **20/20**, first run |
| P67 / P66 integration | 14/14, 15/15 (unchanged behaviour) |
| Focused web (branches dialogs, employees list, offline) | 41/41, then +3 new (create-branch field error, offline refusal) |
| Migration rehearsal | Run 1: seed bug. **Run 2: passed** |
| Typecheck API/web, lint | Clean; 0 errors after fixing 3 non-null assertions in the new test |
| Full API, full web, builds, browser | See §6.1 |

### 6.1 Full suites, builds and browser

| Check | Result |
| --- | --- |
| Full API, run 1 | **1 failed**, 3,879 passed, 6 skipped. The failure was `attendance.repository.test.ts` asserting the exact `findActiveRecord` `where`, which P68 changed on purpose (it now excludes terminated clock-ins). The assertion was updated; that file plus the branches repository test then passed 38/38 |
| Full API, run 2 (final code) | **0 failed, 3,880 passed, 6 skipped, exit 0** |
| Full web | **1,797/1,797, exit 0** (581 s) |
| Production builds | API `tsc` and `next build` pass (compiled in 4.8 min, 89/89 pages, `/admin/branches/closure-items` included) |
| Browser, P68 driver (`tests/e2e/manual/p68/lifecycle.mjs`), local stack on ports 56471–56473, service worker active, Chromium emulation (desktop 1366, phone 390) | Run 1: 23 passed, then the driver stopped on its own bug: it looked for a "Phone" label, but the field is "Contact Number" and optional. Run 2: 25/26. "staff total shown" read visibility without waiting; the screenshot taken in the same run shows the total. Run 3, the whole driver with that wait: **26/26** |
| Browser, P67 regression driver on the same build | **27/27** |
| Not run | Hosted or staging (none exists); real devices; a live old-API process against the new schema; multi-process HTTP race between a terminal checkout and Force Delete |

**Formatting note:** running repository prettier on whole files reformatted thousands of untouched lines, because the existing code does not match `.prettierrc`. This was undone with a three-way merge (original + my changes), so only edited regions carry new formatting.

## 7. Limitations and follow-ups

- **Pending inventory approvals** in Force Delete: code path only, no fixture.
- **Concurrent checkout versus deletion** is covered at the database level: a write after the fence is refused, and the fence waits for in-flight writes by lock semantics. There is no multi-process HTTP race test.
- Production holder of the screenshot email: unknown until the diagnosis is run.
- `lower(email)` unique index: not added; needs a production duplicate check first.
- The Demo same-name supervisor/staff pair: owner decision; nothing changed.
