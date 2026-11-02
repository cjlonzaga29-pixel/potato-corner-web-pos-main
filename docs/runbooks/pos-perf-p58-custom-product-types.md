# POS-PERF-P58 — custom product types

Supervisors can create product types such as Marketing or One-time alongside Regular, Promotional and Seasonal. The Products page is organized by type, and each type opens the existing builder with that type preselected.

A type is a label. It is not an inventory category, a product size or a publication status.

| | |
|---|---|
| Starting SHA | `a92c587` (P57, deployed) |
| Feature commit | `b9d3de4` |
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

- **Publishing:** a product can't be enabled at a branch outside its type's scope, on any publish path.
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

This has one visible consequence: a product labelled Marketing can still be promotion-eligible if it was Promotional before. The Promotions picker shows the type name, and eligibility follows the column.

Manual discount code was not changed and doesn't read the type. No P58 test applies a manual discount to a custom-typed product; the existing P55 and P57 suites passed unchanged.

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
- **Service worker blocked and forwarded IP varied** in all browser runs, the second because of the local rate limiter. PWA caching of the new responses and the rate limits themselves weren't exercised.
- **Browser coverage gaps, integration tests only:** the branch-copy type picker with a custom type (the browser covered a built-in copy only), scope enforcement on publish, promotion retention, and revoked assignments.
- **Not covered:** a real deployed cutover, offline sales queued across builds (the sale path doesn't read the type), and screen readers.
- **Known race:** the per-branch toggle doesn't hold the product catalog lock. If it creates a row for a legacy shared product at a new branch at the same moment that product is assigned a custom type, the product could end up enabled outside the type's scope. The window is very small and affects only legacy shared products.
- **Stock-driven rows:** disabling a flavor can seed an unavailable row for a legacy shared product at a branch outside its type's scope. It isn't sold there, but it blocks assigning a narrower type until scope covers it.
- The test scripts are not all committed. `p58-browser-fixtures.ts` is; the browser drivers were session scratch.

## 10. Git state at the feature commit

`.vscode/settings.json` (already modified at the start) and `.claude/CLAUDE.md`, `docs/CURRENT_HANDOFF.md`, `docs/PROJECT_MAP.md` (which appeared during this work and weren't made by it) were left uncommitted and untouched.
