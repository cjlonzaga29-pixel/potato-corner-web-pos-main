# Product permanent delete, consistent product actions, wider dialogs

Branch `feat/product-permanent-delete` (from `origin/main` `58c335eb`). Local only: not pushed, merged or deployed. Production was not accessed
and no production product was deleted.

## 1. Rule

**Permanently Delete** physically removes a product: the `products` row, its sizes (`product_variants`) and the setup that belongs to that
product alone. History is never changed. Sales, receipts, refunds, voids, reports, held-order lines, variant change logs, stock levels, stock
movements and audit entries keep their own copy of the product's id and name.

Deactivate (one branch), Activate/Publish (one branch) and Archive (every branch, restorable) are separate actions and unchanged.

## 2. Why a migration was needed (traced)

Five foreign keys tied history to the live product with `RESTRICT`:

| Table | Columns |
| --- | --- |
| `transaction_items` | `product_id`, `product_variant_id` |
| `hold_order_items` | `product_id`, `product_variant_id` |
| `product_change_logs` | `product_variant_id` |

So any product that was ever sold, held or edited through the builder could not be deleted. The old Delete refused every such product with
a generic "has associated transactions" message (or a 500 for a recipe line, which is `23001` rather than `P2003`).

History already had independent snapshots:

- **Lines:** name, size, price, deduction, options and promotion.
- **Void and refund:** stock reversal replays `deduction_snapshot`.
- **Deduction worker:** reads the snapshot too.

Only the foreign keys and one report depended on the live row.

**Migration `20261124120000_product_permanent_delete`** (**not additive**: it removes five foreign keys; no data changed):

- Drops those five foreign keys. The columns stay, so every existing row keeps its original ids as historical identity, next to its
  snapshots.
- Adds a live-product guard, `product_delete_require_live_line` and `_variant`, on insert or id change for those three tables.
  - It locks the `products` and `product_variants` rows `FOR KEY SHARE`, exactly like a foreign-key check.
  - So a sale or hold racing a delete either commits first, and the delete sees it, or waits and then fails with
    `PRODUCT_PERMANENTLY_DELETED`.
  - It raises `P0001`, the same reasoning as P67's live-branch guard.
- Adds `hold_order_items(product_id)` index.

Same pattern as P67 (branch deletion): history outlives the live row, and a trigger stands in for the insert half of the foreign key.

**Migration `20261124130000_product_delete_history_guard`** (release-readiness review; triggers only, no data changed). Dropping the
foreign keys also dropped their *delete* half. So the API deployed before this release could have removed a sold or held product during
a rollout or after a code rollback, with none of the checks, locks or audit. Its plain `DELETE /api/products/:id` cascade and its size
delete have no history check. This migration restores that refusal in the database:

- `BEFORE DELETE` on `products` and `product_variants`: if a sale line, held-order line or (for a size) change log still names the row,
  the delete fails with SQLSTATE 23503 and the original constraint name. Prisma reports it as P2003, exactly as before, so the old API
  keeps answering 409 `PRODUCT_HAS_DEPENDENCIES` / `VARIANT_HAS_DEPENDENCIES`.
- It runs after the DELETE has locked the row, so a concurrent sale line (holding `FOR KEY SHARE`) is committed and seen first.
- Only the permanent-delete transaction bypasses it. After its authority and blocker checks, it sets the transaction-local
  `pc.product_permanent_delete` (`set_config(..., true)`). The setting ends with the transaction, so it is safe through the transaction
  pooler.
- New sale and held-order lines must name a size of their own product. Checkout and hold already enforced this; the check applies to
  new rows only.

**Rollout switch `PRODUCT_PERMANENT_DELETE_ENABLED`** (API env, default off). While it is off, the preview says "not switched on yet" and
the DELETE answers 409 `PRODUCT_PERMANENT_DELETE_DISABLED`. See §6 for why and when to turn it on.

## 3. What the delete does

`DELETE /api/products/:id` with body `{ "confirm": "PERMANENTLY_DELETE" }`. A body is required (422 otherwise), so no older client's plain
DELETE can permanently remove a product.

`GET /api/products/:id/deletion-preview` returns what the dialog shows: branches, size count, sale count, branch copies, `can_delete` and
`forbidden_reason`, and blockers. Both endpoints are supervisor-only (super admin has no product write path, POS-PERF-P34/P35).

The delete runs in **one transaction** (`product-deletion.service.ts` / `.repository.ts`):

1. **Locks.** The product's catalog advisory lock (same key as publish, edit and type scope), then `SELECT … FOR UPDATE` on the product
   row.
2. **Re-reads the product.** If it's gone: 410 `PRODUCT_ALREADY_DELETED` when the audit log or outbox shows it was deleted, else 404.
3. **Checks authority over the complete branch scope.** The existing catalog authority (every branch it is set up for, or its exclusive
   branch) **plus every live branch it was ever sold at**. Failing that gives 403 `PRODUCT_DELETE_FORBIDDEN`, naming the branches outside
   the assignment and pointing to Create Branch Copy. A deleted branch never blocks (history is kept either way).
4. **Blockers.** Any of these gives 409 `PRODUCT_DELETE_BLOCKED` with `details.blockers[]` (code, message, next action, names; never ids):
   - `PRODUCT_DELETE_HELD_ORDERS`: an unresolved (`held`) order contains it. Resume and complete, or cancel, first.
   - `PRODUCT_DELETE_IN_PROMOTION` / `PRODUCT_DELETE_IN_DISCOUNT_TYPE`: a promotion or discount type lists it. Remove it there first.
     Shared configuration is never edited by this delete.
   - `PRODUCT_DELETE_USED_AS_SNACK_OPTION`: another product's Mix & Max slot offers one of its sizes. Remove it there first.
   - `PRODUCT_DELETE_LEGACY_SALES`: completed sale lines recorded before deduction snapshots existed. Their void or refund recomputes
     from the live recipe, so deleting it would change what a reversal returns. Deactivate or archive instead.
5. **Deletes only its own setup:**
   - branch availability;
   - each size's flavor links, option-group assignments (and their option picks), recipe components and legacy ingredient links;
   - its flavor slots and their snack options;
   - its sizes, then the product.

   Inventory items, stock, flavors, options, groups, categories, types and other products are untouched. Branch copies made from it stay
   and keep working (their `forked_from_product_id` goes to NULL, the existing `ON DELETE SET NULL`).
6. **Audits in the same transaction.** It enqueues `PRODUCT_PERMANENTLY_DELETED` with a full before-snapshot (name, sizes and prices,
   branches, sale count) in the audit outbox.
7. **After commit, cleans up the image.** The product photo object is removed (best effort; nothing names the key any more).

**Refresh:**

- Lists and counts: the web invalidates `['products']` and drops the product's detail query.
- POS catalogs: get the existing P69R `catalog:changed` hint (the router middleware already looked up the branches *before* a DELETE).

**Concurrency and replay:**

- **Checkout of a deleted product:** 409 `PRODUCT_DELETED`, nothing charged. This happens either at validation (variant missing and
  product gone) or when the insert loses the race to the trigger. The checkout attempt is marked failed, so a retry gets the same answer
  and never a ghost sale.
- **Completed-sale replay:** the idempotency replay runs before validation and returns the original sale.
- **Offline sync:** a queued sale for a deleted product gets per-item `PRODUCT_DELETED`. The web treats it as a definitive rejection, so
  the sale **stays on the device**, visibly refused, for a supervisor to reconcile. It is never resent or substituted.
- **Hold of a deleted product:** 409 `PRODUCT_DELETED` (global handler).
- **Delete retried after success:** 410, nothing changes.

**Also fixed:**

- **Sold sizes.** Dropping the FK removed the only thing that stopped `deleteVariant` from deleting a *sold* size. It now locks the size
  and refuses explicitly (same `VARIANT_HAS_DEPENDENCIES`), and also maps `23001` instead of a 500.
- **Product performance report.** It showed "Unknown Product" for a deleted product. It now falls back to the sale-time name snapshot,
  so the rows are identical before and after a delete.

## 4. UI

**Products list row.** Same order and wording everywhere:

**View · Edit** (Continue Setup for a draft) **· Activate or Deactivate** (at the selected branch) **· Permanently Delete · ⋯**

- The ⋯ menu holds Archive.
- Actions the supervisor can't take are left out.
- **Shared product outside the assignment:** the row says "Set up for a branch outside your assignment — view only." Its ⋯ menu explains
  that Edit, Archive and Permanently Delete need every branch, and that View offers Create Branch Copy.
- No cross-branch edit or delete was granted. The server enforces the same scope.

**Product page.** Edit, Change Status, Archive, then Permanently Delete. The view-only banner now says "can't edit or permanently delete
it" and keeps Create Branch Copy.

**Confirmation dialog** (`permanent-delete-product-dialog.tsx`):

- Fresh server preview, with the product name and branches (on POS or not).
- "What is removed" and "What stays", including the sale count and branch copies.
- "Permanent: it cannot be restored" and "Historical records remain".
- Typing `DELETE` enables the button; Enter submits.
- Cancel and Escape change nothing, and focus returns to the opening button.
- A refusal shows its specific reason and next step. A blocker that appears between opening and confirming replaces the form.

**Dialog sizes** (`components/ui/dialog.tsx` `size` prop, opt-in):

| Size | Max width | Used for |
| --- | --- | --- |
| `form` | 68rem (1088px) | Product Edit dialog (image column and two-column fields), product editor (its own layout, max width raised from 896px) |
| `standard` | 45rem (720px) | Create and Edit Branch, Create and Edit Employee, Add Supervisor, Promotion editor |
| `confirm` | 45rem (720px) | Product Permanent Delete, Archive, Delete Branch, Force Delete Branch, Remove Employee, Delete Expense |

- All sizes are `100vw − 2rem` on smaller screens.
- Sized dialogs keep the header (with the close button) and the footer actions sticky while the body scrolls within the viewport.
- Field pairs in those forms are one column below 640px; before, they were two columns even on a phone.
- The shared default (`max-w-lg`) is unchanged, so POS PIN, payment and other compact prompts are not enlarged. Caller widths were not
  combined with a size (no conflicting classes).
- Small single-field dialogs (units, categories, flavors, options) stay compact.

## 5. Verification (local, disposable data)

All on disposable local data:

- embedded Postgres on 127.0.0.1;
- the P62 stack in `C:\p71s` (ports 56741–56743, DB `p62_p71`, random keys);
- integration clusters in `C:\p71`.

| Check | Result |
| --- | --- |
| API integration `product-deletion.integration.test.ts` (9 scenarios below) | Run 1: 8/9. The failure was my test's offline payload, which lacked the current POS's `discount_flow`, so the server refused it as an old VAT sale first. **Run 2: 9/9** |
| Affected API suites on a fresh cluster (products, product-types, transactions, reports, inventory-deduction, lib, middleware; unit + integration) | **1,479 passed, 6 skipped** (2 gated files), 0 failed. An earlier unit-only run had 6 P62 PDF-route timeouts while a web build was competing for this 7.7 GB machine; they passed here |
| Populated upgrade rehearsal `scripts/test-product-delete-migration-on-populated-data.ts` (20,000 sales, held and released orders, change logs) | **PASS**: 96 tables byte-identical after the migration; foreign keys gone, triggers and index present; no schema drift (`migrate diff --exit-code`); migration wall time 3.5 s including Prisma start-up. See the stock-movement note below |
| Web: new dialog, row and offline tests, affected product, dialog and employee suites | All pass. One real accessibility fix found by a test: two buttons both named "Close" |
| Full web suite | **1,850/1,850** |
| Shared tests | 83/83 |
| Typecheck (shared, API, web) | Clean |
| Lint (shared, API, web) | 0 errors. Warnings are pre-existing, plus `console.log` in the new rehearsal script (same as the P55 script) |
| Production builds (shared, API, web) | Pass |
| Browser `tests/e2e/manual/product-delete/delete.mjs` (headless Chromium, production build; desktop 1366, tablet 1024, phone 390) | **Run 7: 39/39**. Earlier runs are listed below |

**Integration scenarios, real Express and Postgres:**

1. **Unsold product deleted.** Its sizes, availability, components, flavor links and option-group links are gone. The shared inventory
   item, flavor, option group, other products and stock are unchanged. The image is removed. The outbox audit entry has the full
   snapshot. A retry gets 410.
2. **Sold product deleted.**
   - The receipt (`GET /transactions/:id`) is identical before and after, still naming the product and its original id.
   - Stock and stock movements are unchanged.
   - The product performance report is identical.
   - The completed-sale replay with the same key returns the original sale (1 row).
   - A refund after the delete returns exactly the deducted 3 units.
   - The branch copy keeps selling, with `forked_from` cleared.
3. **Deleted product refused for new sales.** Live checkout gets 409 `PRODUCT_DELETED`. Offline sync gets per-item `PRODUCT_DELETED` with
   nothing recorded. The POS catalog and the supervisor list no longer show it.
4. **Scope.**
   - A supervisor of A only, for a product shared with B: the preview gives `can_delete: false` naming Branch B, and DELETE gives 403.
   - Staff and super admin get 403.
   - A missing or wrong confirmation gets 422.
   - The product is unchanged; the A+B supervisor can delete it.
5. **Sale-branch scope.** A product sold at B, then removed from B's setup: the A-only supervisor gets 403 naming B.
6. **Blockers.** A promotion, a held order, and a sale line without a snapshot each refuse with their own code and change nothing. After
   the hold is released, the product deletes and the held line stays as history.
7. **Sold size.** Deleting it alone still gives 409 `VARIANT_HAS_DEPENDENCIES`.
8. **Race: delete holds its locks while a checkout arrives.** The checkout waits on the row lock, observed in `pg_stat_activity` (no
   sleeps). It then gets 409 `PRODUCT_DELETED`: no sale, nothing charged. A retry with the same key gets the same answer.
9. **Race: an uncommitted held-order line holds `FOR KEY SHARE` while a delete arrives.** The delete waits, then refuses with
   `PRODUCT_DELETE_HELD_ORDERS`.

**Browser (supervisor screens):**

- Row actions are in the documented order. The shared product is view only, explained, with no Edit or Permanently Delete. Archive opens
  its own dialog.
- **Delete dialog:**
  - 720 px wide on desktop and fits phone and tablet.
  - Says permanent / cannot be restored / history remains, and names Main Branch.
  - Disabled until DELETE is typed. Focus starts inside, Tab stays inside, and Escape closes and returns focus to the button.
  - Escape and Cancel change nothing. A fitting dialog does not scroll.
- **Unsold and sold products deleted** from the UI (keyboard Enter for one). The sold one's dialog counted its 1 past sale.
- **Held product:** blocked with reason and next action, and no delete button.
- **Shared product page:** no Edit or Permanently Delete, explains why, offers Create Branch Copy.
- **Edit Product:** 1088 px wide in two columns on desktop, one column on phone, Save visible without scrolling. No horizontal overflow on
  the page or in the dialog at any size. The product editor is 1088 px on desktop.
- **Database afterwards:** both deleted products gone. Receipt `MAIN01-20261123-000001` still completed at ₱60, keeping the product id and
  name. Both deletes audited. The held order untouched.

**Browser runs, reported honestly:**

| Run | Result | Cause |
| --- | --- | --- |
| 1–2 | Failed early | Driver: active branch not selected, then the wrong button |
| 3 | 23/25 | **Real defect:** focus didn't return after Escape. Fixed with `useRestoreFocus` on the new dialogs. Plus a driver timeout. The screenshots also showed the shared-row explanation crowding every row; shortened, with the detail moved to the ⋯ menu |
| 4 | 38/38 | But the screenshot showed a **real layout defect:** the sticky bars' negative vertical margins made a fitting dialog scroll and hid the DELETE field. Fixed (`.app-dialog-sized`) and check C5b added |
| 5–6 | Application error | Two web builds started from Git Bash produced a broken bundle ("invariant expected layout router to be mounted"; one logged C:/c: casing duplicates). Not a code issue: a clean build from PowerShell at `C:\…` worked |
| 7 | **39/39** | — |

**Release-readiness review (second pass, same branch).** All on disposable local data (`C:\p72`, embedded Postgres):

| Check | Result |
| --- | --- |
| Integration `product-deletion.integration.test.ts`. New: the history guard refuses the old cascade and a change-logged size (P2003); size/product ownership on new lines; switch off | **12/12** |
| Populated rehearsal, both migrations: 20,000 sales **and 20,000 stock movements** | **PASS**. 96 tables byte-identical. The old cascade is refused (P2003) and changes nothing. After a permanent delete, sales, lines, held lines, change logs, stock movements, stock and items are byte-identical. Migration wall time 16.2 s including Prisma CLI start-up |
| Two-process rollout harness `apps/api/scripts/product-delete-mixed-version.ts`. The API deployed before this release (`58c335eb`, built in a separate worktree) and this branch run as real processes on one database; races are ordered by lock waits | **46/46** checks (run 8; runs 1–7 were harness fixes, below) |
| Browser `tests/e2e/manual/product-delete/offline-queue.mjs`: real service worker and IndexedDB queue; the product is deleted while the terminal is offline | **10/10** (run 4) |

The earlier rehearsal had two gaps, both fixed. Its stock-movement seed was invalid, so that table was empty. Its history fingerprint
named a table that doesn't exist (`inventory_stock`), so stock wasn't compared. It now asserts that every compared table exists.

**Rollout harness results:**

- **Old API on the migrated database, before any delete.**
  - Checkout, completed-sale replay, hold and release, product edit, size add / edit / delete, refund, the deduction worker and offline
    sync all work.
  - Its plain DELETE refuses a sold product and a held product (409 `PRODUCT_HAS_DEPENDENCIES`) and a sold size (409). Nothing changes.
  - A product with no history still deletes (204, as before).
- **Old and new together, switch off.**
  - Preview gives `can_delete: false`; DELETE gives 409 `PRODUCT_PERMANENT_DELETE_DISABLED`.
  - Size delete vs checkout, both orders across versions: the sale commits, then the size delete refuses.
  - "Size delete first" can't happen for a sellable size. A size sells only with a recipe, and a size with recipe components can't be
    deleted alone (pre-existing RESTRICT).
- **Switch on while an old instance still serves** (what the switch prevents):
  - Old checkout first, delete second: the sale commits, the delete waits and then succeeds, and the sale's deduction completes from
    its snapshot. Safe.
  - Delete first, old checkout second: no sale is recorded. But the **old API answers 500 and leaves its checkout attempt stuck
    `in_progress`**, so the POS retry gets `CHECKOUT_ATTEMPT_IN_PROGRESS`. The new API answers 409 `PRODUCT_DELETED`.
  - For a deleted product, the old API's checkout and offline sync answer `PRODUCT_UNAVAILABLE`. The web treats that as retryable, so
    a queued offline sale is resent instead of being settled as refused for reconciliation.
- **After the first permanent delete:**
  - Both versions return the receipt (sale-time name), the sales list and the product performance report (200), and refund the sale
    (200).
  - Both replay a completed sale's key to the original sale.
  - Neither records a new sale of the deleted product.

Harness runs 1–7 failed on the harness, not the product:

- a wrong lock-wait pattern (`pg_stat_activity` shows the client's `INSERT`, not the trigger's query);
- a fixture size without a recipe (unsellable), then one with a recipe (not deletable alone);
- an unhandled rejection that hid the scenario error;
- a stock barrier that caught an earlier sale's deduction worker instead of the checkout.

**Browser offline queue:**

1. The terminal loads the catalog online.
2. Offline, a sale is queued in IndexedDB.
3. The product is permanently deleted through the API.
4. On reconnect, the row stays on the device with `rejection.code = PRODUCT_DELETED` and is never marked synced. Nothing is recorded
   on the server.
5. The Pending tab lists it as "Not accepted" with the reason. After a reload, no sync call resends it, and the catalog no longer
   shows the product.

**Not covered:**

- Real devices and staging, and Render's own deploy overlap (simulated here with two processes).
- An old *web* build (cached PWA) against the new API. By code reading, `PRODUCT_DELETED` is an unknown code there, so the row stays
  queued and retried until the terminal loads the new web. It is kept, never lost and never recorded.

## 6. Release order and rollback

**Order:**

1. Apply **both** migrations together (`prisma migrate deploy`). The API already deployed keeps working and still can't remove
   anything with history (rehearsed: checkout, replay, holds, edits, refunds, worker, offline).
2. Deploy the API with `PRODUCT_PERMANENT_DELETE_ENABLED` unset (off). Old and new instances may overlap during the deploy.
3. Deploy the web. Terminals pick it up on their next load. Until then, an old build keeps a refused offline sale queued and retried.
4. Confirm that **only** the new API version is serving: the deploy is live, the previous instance is gone, and no other service runs
   an older API against this database. Then set `PRODUCT_PERMANENT_DELETE_ENABLED=true`. The env change restarts the service, so every
   instance that sees `true` already runs the new version.

**Why the switch.** With an old instance serving, two things go wrong (§5). A delete that wins a race against its checkout gives the
cashier a 500 and leaves the checkout attempt stuck. Its answer for a deleted product (`PRODUCT_UNAVAILABLE`) makes queued offline sales
retry instead of being kept for reconciliation. Nothing is recorded or lost either way, but it isn't the designed behaviour, so deletion
waits.

**Rolling back:**

- **First, switch off** (`PRODUCT_PERMANENT_DELETE_ENABLED` unset or `false`). This stops new permanent deletes and changes no data.
- **Code, before any permanent delete:** roll back freely. The previous API works on the migrated database (rehearsed), and its plain
  delete is still refused for anything with history.
- **Code, after the first permanent delete:**
  - The previous API still reads receipts, lists and the product performance report, refunds and replays (rehearsed). It can't delete
    anything with history.
  - It has no permanent-delete route, so no new deletion races arise.
  - What degrades: it answers an offline sale of an already-deleted product with `PRODUCT_UNAVAILABLE`, so the sale is retried rather
    than settled as refused.
  - Prefer fixing forward. Roll back only for an unrelated emergency.
- **Migrations, before any permanent delete:** in one transaction:
  1. Drop the two `product_delete_guard_history` triggers and the `product_delete_guard_history()` function.
  2. Drop the three `product_delete_live_product` triggers; the `product_delete_require_live_line()`,
     `product_delete_require_live_variant()` and `product_delete_assert_live_product()` functions; and the
     `hold_order_items_product_id_idx` index.
  3. Re-add the five foreign keys `NOT VALID`, then `VALIDATE` each.

  Then mark both migrations rolled back. Never drop only the guard migration while the first one stays: that reopens the unguarded
  delete for the old API.
- **Migrations, after the first permanent delete:** the five foreign keys **can't** be restored. History names product and size ids
  that no longer exist, so `VALIDATE` fails. The rollback floor is then both migrations; keep their triggers. History is never deleted
  or rewritten to make a constraint fit.
- **Detecting whether a permanent delete happened:**
  `SELECT count(*) FROM audit_logs WHERE action = 'PRODUCT_PERMANENTLY_DELETED'`, plus the same on `audit_outbox`.

## 7. Limitations

- **Older sales without snapshots.** A product whose completed sales predate deduction snapshots can't be deleted (blocker). It can be
  deactivated or archived.
- **Promotions, discount types and Mix & Max.** Links in these must be removed by hand first. The delete never edits shared configuration.
- **Image cleanup.** It is best effort after commit; a leftover object is unreachable.
- **Offline terminals.** A terminal that is offline when the product is deleted keeps it in its cached catalog until it reconnects. A
  sale rung meanwhile is refused at sync and kept for reconciliation.
- **No restore.** Re-create the product if needed. History keeps the old one under its old id.
