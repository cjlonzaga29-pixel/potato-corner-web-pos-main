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

**Migration `20261124120000_product_permanent_delete`** (additive for readers, no data changed):

- Drops those five foreign keys. The columns stay, so every existing row keeps its original ids as historical identity, next to its
  snapshots.
- Adds a live-product guard, `product_delete_require_live_line` and `_variant`, on insert or id change for those three tables.
  - It locks the `products` and `product_variants` rows `FOR KEY SHARE`, exactly like a foreign-key check.
  - So a sale or hold racing a delete either commits first, and the delete sees it, or waits and then fails with
    `PRODUCT_PERMANENTLY_DELETED`.
  - It raises `P0001`, the same reasoning as P67's live-branch guard.
- Adds `hold_order_items(product_id)` index.

Same pattern as P67 (branch deletion): history outlives the live row, and a trigger stands in for the insert half of the foreign key.

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

**Not covered:**

- Real devices and staging.
- Several API instances.
- An offline terminal ringing the deleted product through the real service worker. Covered at the API and queue-rule level only.
- In the rehearsal, the stock-movement seed statement failed (column mismatch in my raw SQL), so that table was empty there. The
  integration test covers movements.

## 6. Release order and rollback

**Order:**

1. Apply the migration.
2. Deploy the API.
3. Deploy the web.

**Why this order:**

- The migration alone changes nothing visible. The old API's delete still refuses sold products. Its old cascade would now succeed for
  a sold product only if nothing else restricted it, so deploy the API promptly after the migration.
- Single API instance, as today.

**Rolling back code:** fine at any time. The triggers keep refusing new lines for missing products.

**Rolling back the migration:**

- Before any product is permanently deleted: re-add the five constraints (`NOT VALID`, then `VALIDATE`), drop the three triggers, the two
  functions and the index.
- **After the first permanent delete, the foreign keys can't be re-added** (history names ids that no longer exist). The rollback floor
  is then this migration.
- Detection query: `SELECT count(*) FROM audit_logs WHERE action = 'PRODUCT_PERMANENTLY_DELETED'` (plus `audit_outbox`).

## 7. Limitations

- **Older sales without snapshots.** A product whose completed sales predate deduction snapshots can't be deleted (blocker). It can be
  deactivated or archived.
- **Promotions, discount types and Mix & Max.** Links in these must be removed by hand first. The delete never edits shared configuration.
- **Image cleanup.** It is best effort after commit; a leftover object is unreachable.
- **Offline terminals.** A terminal that is offline when the product is deleted keeps it in its cached catalog until it reconnects. A
  sale rung meanwhile is refused at sync and kept for reconciliation.
- **No restore.** Re-create the product if needed. History keeps the old one under its old id.
