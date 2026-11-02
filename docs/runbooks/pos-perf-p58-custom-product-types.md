# POS-PERF-P58 — custom product types

Supervisors can create product types such as Marketing or One-time alongside Regular, Promotional and Seasonal. The Products page is organized by type, and each type opens the existing builder with that type preselected.

A type is a label. It is not an inventory category, a product size or a publication status.

| | |
|---|---|
| Starting SHA | `a92c587` (P57, deployed) |
| Feature commit | `b9d3de4` |
| Race and verification fix (P58R, §11) | `cd862cf` |
| Branch | `feat/pos-perf-p58-custom-product-types` (local only: not merged, pushed or deployed) |
| Migrations | `20261103120000_pos_perf_p58_custom_product_types`, `20261103120100_pos_perf_p58_validate_product_type_fk` |

## 1. Audit: what classification does

| Consumer | Uses classification for | After P58 |
|---|---|---|
| Promotions (`promotion-pricing.ts`, `discounts.service.ts`) | **Behavior:** only promotional and seasonal products can have an automatic promotion, re-read at checkout | Unchanged. Reads the column, never the type |
| `is_seasonal` | Compatibility: always equals `classification == seasonal` | Unchanged |
| Season dates | Information only, never read by POS or checkout | Unchanged. Custom types leave them alone |
| Product list, filter, builder, both editors, Promotions picker | Labels and filters | Show the actual type name |
| Branch copy | Copied from the source | Copied, plus the rules in §5 |
| POS catalog, checkout, recipes, stock, tax, reports, offline | Nothing | No change. None of them read the type |

## 2. Data model and built-in mappings

- **Built-ins are not rows.** Regular, Promotional and Seasonal are `ProductClassification` values, listed by the API from constants. **No built-in field can be edited**: they can't be renamed, deactivated or deleted (`PRODUCT_TYPE_BUILT_IN`, 409), and there's no row to delete by accident.
- **`products.product_type_id`** is set only for a custom type. `NULL` means the built-in named by `classification`.
- **`product_types`** holds name, normalized name, description, active state and version.
- **`product_type_branches`** holds the scope. A composite foreign key with `ON UPDATE CASCADE` copies the normalized name and active state onto each row.

Requests and responses use a type *key*: a built-in's classification, or a custom type's id. Products also return `product_type: { key, id, name, is_builtin, is_active }`.

### Name uniqueness

**Normalization** (`normalizeProductTypeName`): NFKC, trim, collapse inner whitespace, lowercase.

**One active type per name per branch** is enforced by the partial unique index `product_type_branches_active_name_key`, not a service check. Because of the cascade, the same index decides concurrent creates, renames and reactivations. A collision returns `PRODUCT_TYPE_NAME_TAKEN` (409).

- The same name is allowed at a different branch. It is refused when scopes overlap.
- A deactivated type keeps its name, and that name can be reused. Reactivating is then refused until one of them is renamed.
- CHECK constraints refuse the built-in names, names that weren't normalized, and names outside 1–60 characters.

## 3. Ownership and authority

Same rule as shared products (`catalog-authority.ts`), always read from live assignments, never the JWT.

| Action | Requires |
|---|---|
| See or use a type | An active assignment to at least one branch in its scope. Otherwise it is not found (404), so a forged id reveals nothing |
| Create | An active assignment to every selected branch |
| Rename, edit, deactivate, reactivate | Assignments covering the type's **whole** scope (`PRODUCT_TYPE_SCOPE_FORBIDDEN`, 403) |
| Add branches | The above, plus an assignment to each added branch |
| Remove branches | Not allowed (`PRODUCT_TYPE_SCOPE_NARROWING`, 422): products may use them. Create a new type instead |

Super admin can read but not write, staff get neither, and sharing a product never makes its type editable. If a branch in a type's scope is closed, no supervisor covers the scope and the type can't be changed until the branch reopens. Shared products behave the same way.

## 4. Products page

- **Navigation:** All Types, built-ins, then custom types, as a wrapping list that scrolls within its own height. Inactive types are labelled.
- **URL:** the selection is `?type=<key>`, so reload and Back keep it, and the builder's Back link returns to it. A type not usable at the current branch falls back to All Types.
- **Actions:** All Types offers **Create Product**, which asks for a type first. A selected type offers **Create \<Type\> Product**. **Create Product Type** stays a separate action.
- **Counts:** the tab counts follow the selected type, and the type counts follow the selected tab and search. Both come from one read, so they can't disagree with the list.

## 5. Assignment rules

A custom type is checked only when newly assigned, inside the write's transaction:

1. It must be visible to the actor.
2. It must be active. A row lock means a concurrent deactivation lands wholly before or after the assignment.
3. Its scope must cover every branch the product is configured at (`PRODUCT_TYPE_BRANCH_MISMATCH`, 422).

An unchanged type is never re-checked, so a product with an inactive type still saves unrelated edits.

- **Publishing:** a product can't be enabled at a branch outside its type's scope, on any publish path. Since P58R this is enforced under the product's catalog lock (§11).
- **Branch copies:** a copy keeps a custom type only if it is active and scoped to that branch. Otherwise the supervisor must choose one (`PRODUCT_TYPE_SELECTION_REQUIRED`, 409). A scope is never widened by a copy, and a retry returns the same copy.
- **Builder:** a saved draft's type comes from the server. Before the first save, the URL holds the selection, and a change made there is kept in the draft store. A type invalid for the selected branches blocks Continue with a reason and is never swapped silently.

## 6. Deactivation

Deactivating stops new assignments and changes nothing else: no product, availability, variant or stock row is written. Products keep their type, stay discoverable in All Types and in the type's own view, and stay on POS. Types are never hard-deleted by the app, and `products.product_type_id` restricts deleting a referenced row.

## 7. Promotions and manual discounts are preserved

**Deliberate mapping: a custom type never changes `classification`.**

| Situation | Result |
|---|---|
| New product with a custom type | `classification = regular`: can't have an automatic promotion, whatever the type is called |
| Promotional or Seasonal product moved to a custom type | Keeps its classification and any running promotion at the same discount. The editor says so |
| Renaming or deactivating that type | The promotion continues |
| Custom type back to a built-in | That built-in's classification, as an explicit choice |
| Promotional or Seasonal product moved to built-in Regular | An automatic promotion stops applying at once, because classification is re-read at every sale. The promotion stays enabled |

This has one visible consequence: a product labelled Marketing can still be promotion-eligible if it was Promotional before. The Promotions picker shows the type name, and eligibility follows the column. Since P58R the editors explain this before saving (§11.2).

Manual discount code was not changed and doesn't read the type. P58R applied manual discounts to a custom-typed product in a real browser (§11.3).

## 8. Migration, overlap and rollback

**Additive, with no backfill.** No existing row is written, so there's nothing for an older client to make stale. No legacy column is removed. Deploy the API before the web.

| Writer | Outcome |
|---|---|
| Old API insert | `product_type_id` is NULL, so it reads as the classification it wrote |
| Old API edit, built-in product | Moves the built-in, with no second column to reconcile |
| Old API edit, custom-typed product | Keeps the custom type. If it changes classification, the column moves and the label doesn't |
| Old web → new API, unchanged classification resent | Keeps the custom type |
| Old web → new API, different classification | An explicit choice of that built-in; clears the custom type |
| Old web, custom-typed row | Shows its classification label (usually Regular) |
| Old web → new API, branch copy needing a type choice | Refused with a message; old web has no picker |
| Old API branch copy of a custom-typed product | The copy has no custom type and reads as its classification |
| New web → old API | Built-ins work. No custom types are listed. Create Product Type is refused visibly and writes nothing; the message is the raw 404 text |

**Rollback limits once custom types exist.** Roll back the code only, and leave the tables and column in place.

- The old code ignores them. Custom-typed products show their classification label until the new code returns, and assignments survive.
- Pricing and promotions are unaffected, because neither ever read the type.
- While rolled back, nothing enforces type scope when publishing, and copies drop the custom type.
- Dropping the column or tables would permanently lose every custom assignment. Don't do it in this release.

## 9. Verification

Everything ran on a new local embedded Postgres (`127.0.0.1:47858`, databases `p58_verify` and `p58_browser`) with API on 4158 and web on 3158/3159. No production, `pos_verify` or other session's database was used. Builds and suites ran one at a time.

| Check | Result |
|---|---|
| Migration rehearsal (`test-p58-migration-on-populated-data.ts`): 5,000 products, 2,000 sales | PASS. 83 tables' existing columns byte-identical, no schema drift |
| P58 integration tests | 30 / 30 |
| Full API suite on a freshly migrated database | 3,632 passed, 5 skipped, 0 failed (215 files passed, 1 skipped) |
| Full web suite | 1,621 passed, 0 failed (177 files) |
| Typecheck, API and web | Clean |
| Lint, API, web and shared | 0 errors (396 and 1 warnings, API and web) |
| Builds: shared, API, web | Pass |
| Browser sweep on final builds, fresh database | 30 / 30 |
| Old web (a92c587) → new API, real browser | 5 / 5 |
| New web → old API (a92c587), real browser | 6 / 6 |

**Proved by integration test:** eight concurrent creates of one name give one winner and clean 409s; revoked assignments and forged ids fail; assignment racing deactivation never lands after it; a past sale's items are unchanged by a rename; sales of types named like promotions match a control's total, VAT and stock effect, and sell repeatedly.

**Proved in the browser:** creating types; duplicate and built-in names refused inline; six concurrent API creates (one 201, five 409); preselected builder; draft and reload recovery; scope blocking in the builder; rename and deactivate labels; independent tabs, counts and search; forged URLs; 30+ types at 1280, 820 and 390 px in light and dark with no sideways overflow; a 60-character name on a phone; keyboard navigation with visible focus and focus returning after a dialog closes.

**Found and fixed by the sweep:** a new type could fall back to All Types before the refreshed list arrived; a custom `?type=` briefly showed the generic Create Product button; type dialogs lost focus on close; a long name overflowed the empty state; the selected type could scroll out of view in the nav.

### Failures and limits

- **One sweep run failed 9 of 30** after a page load exceeded the 15-second driver timeout, and later steps depended on it. The next run from a clean database, on the same build, passed 30 / 30. The cause wasn't established; machine load is suspected, because several builds had just finished.
- **Earlier sweep failures** were driver faults: wrong auth for same-origin `/api`, branch selection, the local rate limiter. **Overlap reruns** failed twice on driver timing or repeated input and passed once corrected.
- **One web test** (`promotion-editor-dialog`) failed once in a filtered run under load, then passed alone and in the full suite. The cause wasn't established.
- **Service worker blocked and forwarded IP varied** in all browser runs of this section, the second because of the local rate limiter. P58R ran with the worker active and the limiter untouched (§11.4).
- **Browser coverage gaps here, closed by P58R:** the branch-copy type picker with a custom type, scope on publish, promotion retention and revoked assignments (§11.3, §11.4).
- **Not covered:** a real deployed cutover, offline sales queued across builds (the sale path doesn't read the type), and screen readers.
- **Known race:** closed by P58R (§11.1).
- **Stock-driven rows:** a custom-typed product no longer gets one (§11.1). A legacy product with no custom type still does; it isn't sold there, but it blocks assigning a narrower type until the scope covers it.
- The test scripts are not all committed. `p58-browser-fixtures.ts` is; the browser drivers were session scratch.

## 10. Git state at the feature commit

`.vscode/settings.json` (already modified at the start) and `.claude/CLAUDE.md`, `docs/CURRENT_HANDOFF.md`, `docs/PROJECT_MAP.md` (which appeared during this work and weren't made by it) were left uncommitted and untouched.

## 11. P58R: type-scope race and focused verification

Tested code: `cd862cf`, on `3e0df7b`. No push, merge, deployment or production access. Everything ran on a new local cluster (`127.0.0.1:47859`, databases `p58r_verify` and `p58r_browser`), with API on 4159, web on 3160, and an isolated local Storage project on 54521, stopped afterwards.

### 11.1 Race and fix

**The invariant:** a product with a custom type is never *available* at a branch outside that type's scope.

**The bug:** the per-branch toggle, bulk availability and branch status change checked the type, then wrote outside any lock. Assignment already held `productCatalogLockId`, but it can't see an uncommitted row.

**Reproduction** (`p58r-type-scope-race.integration.test.ts`): each race is forced. One side pauses inside its transaction, and the test confirms from `pg_locks` that the other is queued before releasing it. On unfixed `3e0df7b`, 10 of the 15 tests then in the file failed:

- **Race:** 6 tests. All three enable paths, in both orders, ended with the product enabled outside its scope.
- **Audit:** 3 tests, covering restore (2) and branch copy (1).
- **Stock cascade:** 1 test. That run failed on a mistake in the test's setup. With the setup corrected, removing the fix showed the out-of-scope row was created.

**The fix:** turning a product on now takes the same lock and repeats the guards on committed data (`lockAndAssertMayEnable`). No new global lock, permission rule or migration.

| Order | Winner | Loser |
|---|---|---|
| Type assignment first | Type saved | The enable waits, then gets `PRODUCT_TYPE_BRANCH_MISMATCH` (422). No row is written |
| Availability enable first | Row saved | The assignment waits, then gets the same 422. Type and version are unchanged |

| Path audited | Finding |
|---|---|
| Per-branch toggle, bulk, branch status change | Race, fixed. A bulk with one bad branch writes nothing |
| Publish | Already held the lock. Both orders now tested |
| Restore | **Gap, fixed.** It could turn on an unavailable row outside the scope. It now takes the lock and turns on only rows in scope |
| Stock-driven flavor cascade | **Gap, fixed.** It could add a row outside the scope to a custom-typed product |
| Branch copy | **Gap, fixed.** If the source changed after the check, the copy took the unchecked type, even a deactivated one. It now takes the type it checked |
| Copy replacing its source | No gap: the copy's only row is at a branch its type covers |

Turning a product **off** stays unlocked, so an urgent disable doesn't queue behind a publication. It can leave an *unavailable* row outside the scope, which enabling refuses and restore skips.

### 11.2 Type and promotion behavior

The product editors now show a notice as soon as the type changes, before anything is saved. It appears in the Edit Product dialog and the editor's Details form. No pricing or promotion behavior changed.

| Change | Notice says |
|---|---|
| To a custom type, from Promotional or Seasonal | Only the shown name changes, and a running promotion keeps its discount. Changing the type doesn't stop it |
| To a custom type, from Regular | Only the shown name changes. It still can't have a promotion, whatever the type is called |
| To built-in Regular, from an eligible classification | A running automatic promotion stops applying on save. The promotion stays in Promotions |
| Between Promotional and Seasonal | Still eligible, same discount |
| From Regular to Promotional or Seasonal | It can now have a promotion, and an enabled one that includes it applies from the next sale |

The first draft of this notice wrongly said moving to Regular doesn't stop a promotion. Reading `resolvePromotionsForBranch` caught it, and a Postgres test now proves all three facts: custom type keeps it, Regular stops it, the promotion stays enabled.

**Also fixed:** the product detail header called every non-seasonal product "Regular", including custom-typed and promotional ones. It now shows the actual type.

### 11.3 Browser: service worker blocked, 53 / 53

Final build, fresh database, real local Storage.

- **Branch copy:** a source with an inactive type needs a choice; the picker offers only that branch's active types; the copy gets the chosen type at its branch only; the old type's scope is unchanged; a retry returns the same copy; a usable type needs no choice.
- **Publication:** the copy publishes in scope through the UI and reaches that branch's POS catalog only. Enabling outside the scope is refused, with nothing written.
- **Manual discount on a custom-typed product:** eligibility follows the discount's product list, not the type. The total, stored snapshot and original cashier are correct, stock is deducted once, and a control product totals the same.
- **Retry:** a lost response resends one key and produces one sale, with the same cashier and one deduction.
- **Required proof:** Charge is blocked until a photo is attached. A gallery upload went to real local Storage, bound to the cashier and consumed by that sale. The bucket is private, and a signed URL reads the photo.
- **Rename and deactivate:** the product keeps its type and stays on POS. The past sale and its items are byte-identical. A new assignment is refused, and the product still sells.

### 11.4 Browser: service worker active, 37 / 37

The production worker controlled the pages, in ordinary Chromium, with offline set through the browser context.

- **Refresh:** creating, renaming and deactivating a type updates the visible choices, and a cached list doesn't undo them on reload. Another supervisor's rename arrives on reload.
- **Branch switching:** each branch shows only its own types. Switching offline to a branch this browser never cached doesn't show another branch's custom types.
- **Reload:** the selected type, a saved draft's type and a new product's preselected type are all restored.
- **Stale and offline:** a type deactivated while the editor is open is refused visibly. A save made offline never wrote a type deactivated in the meantime. A revoked assignment can't complete from a stale list. The worker caches reads only.
- **Queued sale:** it survives an offline reload byte for byte and syncs with its original provisional number, items, shift and cashier, despite its type being deactivated meanwhile. Stock is deducted once. The same device replaying the batch gets the same sale and adds nothing. A manual discount can't be applied offline.

### 11.5 Checks on the final code

| Check | Result |
|---|---|
| Race tests, real Postgres | 16 / 16 |
| Full API suite, freshly migrated database, serial | 3,648 passed, 5 skipped, 0 failed (216 files passed, 1 skipped) |
| Full web suite | 1,627 passed, 0 failed (177 files) |
| Shared suite | 54 passed |
| Typecheck: shared, API, web | Clean |
| Lint: shared, API, web | 0 errors. 397 API warnings, 1 web warning. The one new API warning is `console.log` in the new fixture script, as in the P57 fixture |
| Builds: shared, API, web | Pass |

The migration rehearsal was not re-run, because P58R changes no schema.

### 11.6 Failures along the way

- **First full API run:** 9 failed and 104 were skipped. The cause was my environment: `ENCRYPTION_KEY` wasn't valid base64, and `TEST_REDIS_URL` was unset. It passed once both were fixed.
- **First full web run:** 12 failed, all 5-second timeouts in three files P58R didn't change. A filtered re-run failed one different terminal test the same way, then that file passed 169 / 169 alone, and the full suite passed on a quiet machine. Load is the likely cause, not proven.
- **Overlap:** one API suite ran during a web build, against the instructions, because stopping its script didn't stop it. I killed it, and none of its output is used. That web build succeeded and is the build tested.
- **Browser passes** took repeated runs. The fixes were to the driver: selectors, the order of steps, a menu closing while the page loaded, and colliding with the app's reload on reconnect.
- **One real limiter hit:** a rename got a 429 when the terminal and a new supervisor session shared one IP's 100 requests a minute. The dialog stayed open. The driver now pauses there, and the final runs had no 429s.
- **The first service-worker run** asserted an `idempotency_key` that queued sales don't have, which made its sync checks meaningless. They now use the real identity.

### 11.7 Migrations and rollback

**P58R adds no migration.** P58's complete inventory is still two:

| Migration | Effect |
|---|---|
| `20261103120000_pos_perf_p58_custom_product_types` | Additive: two tables, one nullable column, a `NOT VALID` foreign key, no backfill |
| `20261103120100_pos_perf_p58_validate_product_type_fk` | Validates that foreign key without blocking product reads or writes |

**Rollback:** `cd862cf` can be reverted on its own with no data step. That reopens the race and the §11.1 gaps. Limits from §8 still apply: roll back code only, and don't drop the column or tables, because that permanently loses custom assignments.

**Rows from before this fix aren't repaired.** Before deploying, a read-only check can look for products available outside their type's scope. It has not been run on production:

```sql
SELECT p.id, a.branch_id FROM products p
JOIN branch_product_availability a ON a.product_id = p.id AND a.is_available
WHERE p.product_type_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM product_type_branches s WHERE s.product_type_id = p.product_type_id AND s.branch_id = a.branch_id);
```

### 11.8 Remaining limitations

- **Not tested:** a physical camera (gallery upload only), an installed PWA, real iOS or Android devices, a deployed cutover, screen readers, and the rate limits under load.
- **Enforced in the app, not the database.** An older API instance during a rolling deploy, or a direct database write, can still break the invariant.
- **Stock cascade and disable aren't locked,** so they can race an assignment. The worst case is an unavailable row outside the scope.
- **Discontinue and archive don't take the lock.** An enable that passed its check just before can leave an available row on a discontinued product. POS hides it by status, and it isn't a scope problem. This predates P58R and wasn't changed.
- **Offline saves:** the app reloads on reconnect (`reloadOnOnline`). A waiting save is either dropped by that reload or reaches the server first and is validated. One run saw a waiting built-in type change applied after reconnecting. The dialog gives no separate warning.
- **Offline lists:** `/api/*` reads are cached by URL for up to 24 hours (16 entries), not per user, so an offline reload can show an older list. The server still decides every write. Two people sharing a device offline wasn't tested.
- **Queued sale identity** is branch, device and provisional number. A replay with a different device id created a second sale in an earlier run. The app always sends its own id; a forged one isn't defended against here.
- **Integration tests only, not browser:** the forced races themselves, bulk, restore and copy replacement. The notice in the editor's Details form has a component test; the browser drove the Edit Product dialog.
- **`.env.example`** describes `ENCRYPTION_KEY` as hex, but the code decodes it as base64. Not changed; worth correcting separately.
- **Scratch only:** the browser drivers aren't committed. `apps/api/scripts/p58r-browser-fixtures.ts` is.
