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
   - The live-branch trigger (P67 function, replaced in the P68 migration) now locks the branch row **FOR SHARE**. The fence UPDATE therefore waits for every guarded write already in flight, and every later write is refused. The guarded writes are sales, stock movements, shifts, clock-ins, expenses, Extra Supplies, payroll, and now **hold_orders**, **checkout_attempts** and (follow-up migration, §5) **inventory_approval_requests**.
   - **Status-only writes** (follow-up migration): an UPDATE of `transactions.status` or of `inventory_stocks.quantity_on_hand`/`quantity_reserved` is refused while the branch row exists and is fenced (`pos_perf_p68_refuse_fenced_branch_update`, same message, same FOR SHARE). This closes a gap the race run found: a void of a sale whose deduction is still pending only UPDATEs rows, and it committed after the fence. A deleted branch's history is not affected (no branch row, no refusal). Finalize never updates these columns.
   - Not fenced, by design: closing a shift, clocking out, failing a checkout attempt, and reviewing (return/cancel) an approval. Each resolves an item that is already in the plan; finalize then finds it changed, stays fenced for one retry, and completes without it (tested, §6.2). The resolved record is the real one (a counted cash close, a real clock-out).
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
- **Pending inventory approvals** are now tested through the real workflow (§6.2 A1–A3): a supervisor's physical count, then approve by another reviewer.
  - Approve re-checks the request status inside its transaction (conditional update from PENDING). The branch state is enforced by the database: its stock write is refused once the branch is fenced, so the whole approval rolls back and stays PENDING; finalize then cancels it unreviewed.
  - Approve after deletion is refused (409 `ALREADY_PROCESSED`); it cannot recreate the branch or its stock row.
  - The approval row (with its proof key and history) is kept and stays readable by a Super Admin at `GET /api/inventory-approvals/:id`. The closure snapshot now carries the target, operation, item, entered/counted quantities, delta, on-hand at submission, reason, proof key and revision.
  - Known edge (not fixed, harmless): a zero-variance count writes no stock, so its approve is not stopped by the fence. It ends APPROVED with no stock change; finalize retries once and completes.

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

**Transient failures are retried, not reported done.** A finalize that loses a Postgres deadlock (40P01; observed only with the follow-up triggers disabled, §6.2) or meets an item changed under it stays `fenced` with step `retry_pending`. The next repeat, status poll or 30 s sweep finishes it.

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

**Follow-up migration** `20261123130000_pos_perf_p68_fence_updates_and_approvals` (new, additive, triggers only):
- the live-branch guard on `inventory_approval_requests` (INSERT or `branch_id` change);
- `pos_perf_p68_refuse_fenced_branch_update` on `transactions` (UPDATE OF `status`) and `inventory_stocks` (UPDATE OF the two quantities). It refuses only while the branch row exists and is fenced.
- Cost: those updates now take FOR SHARE on the branch row (a sale already did in the same transaction). A branch edit waits for in-flight stock updates of that branch.

**Migration inventory (P68):** `20261123120000_pos_perf_p68_branch_force_deletion`, `20261123130000_pos_perf_p68_fence_updates_and_approvals`. Both are additive; neither changes a row. `prisma migrate diff` from the migrated local DB to the pre-P68 schema (`365758c4`) lists only the P68 tables, nullable columns and the `terminated` enum value: no existing column, type or default changes.

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
- **No Force Delete until every API instance runs P68.** An old API doesn't know the fence (normal Delete or edits of a fenced branch) or `ShiftStatus.terminated`. This is documented, not database-enforced. Code trace of `365758c4` against the migrated schema:
  - with no fence set, the new triggers only read the branch row. Old checkouts, holds, voids, stock writes and approvals on live branches behave as before;
  - a fenced write on an old instance is still refused, but answers 500 (the old code doesn't map `POS_PERF_P68_...`);
  - an old P67 Delete of a fenced branch would remove it under the operation, which then stays fenced ("branch is missing") until a person intervenes. Hence the rule.
  - Not run: a live pre-P68 API process. It needs a separate full install of `365758c4`, and no new clone or worktree was authorized.
- **Email reuse** (re-verified by code trace and the existing tests): a reused email always gets a new `users` id (the P66 trigger refuses reusing a deleted id). Old refresh tokens are deleted with the old user, old access tokens die through the removed-account marker keyed by the old id, and history stays on the old `people` record. Create Branch only reports who holds an email; nothing deletes a valid account because a branch is absent. The leftover repair runs only from its script, on exact ids, dry run first, and refuses a live, shared or open-work account.

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

### 6.2 Multi-process races (follow-up)

`apps/api/scripts/p68-process-races.ts` runs three real built API processes (`node dist/server.js`, ports 56482/56484/56485, each with its own pool, deduction worker and sweeper) against one fresh disposable embedded Postgres (`p62_p68race`, port 56481, root `C:\p68r`, P62 seed with small sales counts). Races are ordered by database barriers: the script holds a row or advisory lock in its own transaction, and waits until the API statement is actually blocked (`pg_stat_activity`, `pg_blocking_pids`). No sleeps order a race, and no debug or bypass route exists. Every call is a normal route with a normal signed token.

| # | Scenario (process) | Barrier | Result |
| --- | --- | --- | --- |
| S0 | Live branch: checkout on A and B, paid supply issue, the same idempotency key on A and B at once, void | none | All succeed; one sale for the shared key |
| S1 | Checkout commits first (A), Force Delete (B) | stock row: the sale INSERT is done, its reservation waits | The fence waits for the sale; sale 201; operation **aborted** on the changed plan, fence lifted. A fresh confirmation completes; the sale stays on the branch record; the same-key retry is refused (403) and the lookup returns the original sale; one sale |
| S2 | Fence first (A), checkout (B) | shift row: finalize waits | 409 `BRANCH_DELETION_IN_PROGRESS`, no sale, no attempt; same-key retry still 409 (retryable); completes; shift `terminated` with no cash count |
| S3 | Checkout claimed before the fence, sale INSERT after (A vs B) | the branch's receipt-counter row | The plan lists the in-progress attempt; the late sale gets 409; completes; attempt abandoned, with a closure item; no sale for the key |
| S4 | Claimed deduction worker vs Force Delete | the worker's stock advisory lock (the sale's reservation doesn't take it) | Job claimed (`processing`); finalize waits on the job row; the worker's stock write is refused; job `cancelled`, claim cleared, no movement; stock snapshot equals the exact pre-deletion balance |
| S5a | Paid supply issue in flight (first stock item deducted) vs fence | the second stock row | The fence waits; issue 201; operation aborted; a fresh confirmation completes; the paid issue (₱20) is kept |
| S5b | Paid issue started before the fence, writes after | the first stock row | 409; no issue, line, payment, operation or movement |
| S6 | Void of a sale whose deduction is pending, after the fence | worker advisory lock + shift row | **Defect before the fix** (the status-only write passed the fence). Now 409; sale not voided; completes |
| S7 | Lost response and crash: process C killed mid-finalize, its backend terminated | shift row | Operation durably `fenced`, branch not half-deleted; concurrent repeats of the same id on A and B both return that operation, and it completes; closure items once; a new id reports `already_deleted`; another admin's reuse of the id is refused |
| S7b | Crash, then restart of C | shift row | The start-up sweep completes the fenced operation |
| A1 | Approve commits first, then Force Delete with the confirmation made before it | none | Approve 200 (stock 999,000); the stale confirmation gets `FORCE_DELETION_PLAN_CHANGED`, nothing changed; a fresh one completes; snapshot 999,000, no write-off; approval still readable |
| A2 | Fence first, approve in flight writes after | stock row | Approve 409, rolled back; request `CANCELLED` unreviewed, with the full snapshot (quantities, proof key); no movement; approve after deletion refused; branch not recreated |
| A3 | New count, and reject (cancel), while fenced | shift row | **Defect before the fix** (a new count was accepted and made Force Delete abort, leaving a pending request). Now the new count gets 409; the cancel is recorded once; finalize retries once and completes; one request |
| Z | Other branches | none | Every pre-existing stock row of every other branch unchanged |

Runs (all kept in `C:\p68r\out`):
- **Run 1, repro mode** (`P68R_WITHOUT_FIX=1` disables the follow-up triggers on the disposable DB; the D2 and snapshot fixes were already in the build): 88/101.
  - It reproduced the approval defect (A3).
  - S4 and S6 stopped on a harness bug (the advisory lock was read as `void`), and S3 on a harness ordering bug (the warm-up sale's deduction changed the plan).
  - S5a stayed fenced: finalize lost a **deadlock** to the unfenced issue, which held a stock row lock without the branch share lock. The sweeper finished it later, so it recovered.
- **Run 2, repro mode, S5 only:** the same deadlock, logged as `40P01`, operation `retry_pending`, then completed.
- **Run 3, fixed:** 132/133. The failure was the other-branches check. Attributed to branches left live by run 1's stopped scenarios (their held jobs completed later), **not proven**; the check now names the changed rows.
- **Run 4, S0 only:** 5/5. **Run 5, fixed, full:** **133/133**.
- **Run 6, final code, full:** 132/133. The other-branches check failed on one stock row of branch `P68R s0 mwrt355k` (run 4): 1,000,000 on hand / 200 reserved became 999,800. Run 4 stopped its processes right after its sales, and run 6's workers completed those deductions. That is a harness baseline bug, not a Force Delete effect (and the likely cause of run 3's failure too). The harness now lets the workers drain pending jobs before taking the baseline.
- **Run 7, final code, full:** **133/133**.

Also fixed in this review, found by code trace and then tested:
- **D2:** two concurrent requests with one operation id. The second got 409 `FORCE_DELETION_IN_PROGRESS` (or `BRANCH_CHANGED`, since the fence bumps `updated_at`). It now re-reads its own operation and returns its status (in-process test, plus S7).

### 6.3 Follow-up verification

On fresh disposable embedded Postgres, sequentially, on the tested code, committed as `2441628c` (the race runs used the same build).

| Check | Result |
| --- | --- |
| Focused API (branches, inventory-approval, extra-supplies, inventory-deduction, universal-inventory), run 1 | 477/478. My new test created a stock row that `blockedBranch` already makes (test bug). Fixed; P68 + P67 integration **36/36** |
| Full API, run 1 | **8 failed**, 3,874 passed, 6 skipped: `p62-pdf-isolation` admission timing (415 vs 100 ms), a `p58-product-types` count (57 vs 56), and 6 in `p59-report-coverage` cascading from one Daily Sales PDF 503 under load (later tests found 99 of 101 sales). None touches the changed code. **The three files alone: 66/66** |
| Full API, run 2 | **1 failed**, 3,881 passed, 6 skipped: `transactions.integration.test.ts` "two concurrent sales ... exactly one". The sale assertions passed (one sale, one `INSUFFICIENT_STOCK`); the stock was still 200 after `runCycle(10)`. The worker claims the 10 oldest due jobs globally, so parallel files' jobs can crowd this one out. It passed in run 1 and **alone 3 × 16/16**. Attributed to that cross-file batch, not proven; test and worker are unchanged. **No fully green full API run on the final code**: across the two runs, no failure repeated, and each passes alone |
| Migration rehearsal (both P68 migrations) | Run 1: my new stock-update check had no stock row in this seed (removed; covered by the integration test and S4, S5b and A2). **Run 2: passed**, 94 tables byte-identical, no drift |
| API typecheck / lint (changed files) | Clean / 0 errors (after removing `any` and non-null assertions from the harness) |
| Web | Not rerun: no web code changed (last full web 1,797/1,797 at `8f882aaa`) |
| Browser | Not rerun: no UI or route change (last P68 driver 26/26 and P67 27/27, at `8f882aaa`) |

**Formatting note:** running repository prettier on whole files reformatted thousands of untouched lines, because the existing code does not match `.prettierrc`. This was undone with a three-way merge (original + my changes), so only edited regions carry new formatting.

## 7. Limitations and follow-ups

- **Multi-process races** are now tested over HTTP with real processes (§6.2). Still not tested: real devices, a hosted environment, a live pre-P68 API process, and load. Under load, the FOR SHARE fence can wait behind a busy branch's writes up to its 30 s timeout, which answers 500 with nothing changed.
- **Deadlock window:** a stock write that locks its row in the instant before finalize's cascade can still deadlock with it. Postgres aborts one side; finalize retries (§3.5), and a refused write is not committed. Observed only with the follow-up triggers off.
- **Other processes' caches:** only the process that completes a Force Delete kicks sockets and clears its auth caches. Another instance accepts a deleted account's token for up to 60 s and its active status for 10 s. Its writes are still refused by the database.
- `BRANCH_FORCE_DELETION_STARTED` is audited after the fence commits, so a crash in between loses that one audit row. The operation row itself is durable.
- **Zero-variance count approval** on a fenced branch is not refused (§3.3).
- **Production leftover-account diagnosis and repair: NOT run.** It stays a separate, owner-approved step (exact ids, dry run first).
- Production holder of the screenshot email: unknown until the diagnosis is run.
- `lower(email)` unique index: not added; needs a production duplicate check first.
- The Demo same-name supervisor/staff pair: owner decision; nothing changed.
