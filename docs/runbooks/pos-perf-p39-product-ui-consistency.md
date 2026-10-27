# POS-PERF-P39 — Consistent POS cards and simpler Products management

Starting HEAD: `04117f73197acdd489dfef088a233a6fb2df0650` (POS-PERF-P38R4), clean tree, no newer
remote commits. No schema change, no migration, no new library. Nothing was pushed or deployed,
and nothing touched production data. The duplicate "Cheese Fries" test product in production
was not touched.

## 1. POS cards

### Root causes (reproduced in a real browser against the HEAD build)

Probe: built API + `next build`/`next start`, real staff login. Only the catalog and the
attendance read were intercepted so every card case was controlled: photo, no photo, 404 photo,
4-second photo, very long name and size, low stock, out of stock, not ready with a reason. A
background refresh went through the terminal's real 30-minute `refetchInterval` (Playwright fake
clock). The terminal turns focus refetch off, so a "refresh" is not a page reload. Script:
`.p39-local/cards.mjs` (local only, listed in `.git/info/exclude`, not committed).

| Layout (HEAD) | Card widths in one grid | Card heights | Skeleton vs card |
| --- | --- | --- | --- |
| 1024×768 touch | 119.7 – 200 px (7 sizes) | 159.6 – 266.7 px | 81×108 vs 138×184 |
| 390×844 phone | 87.7 – 200 px (8 sizes) | 116.9 – 266.7 px | 69×92 vs 106×141 |

(The first 1366×768 run showed the same: 5 widths from 119.7 to 200 px.)

1. **Each card was sized by its own text.** `.app-pos-card` had `max-width: 200px;
   margin-inline: auto` and no width. Auto inline margins switch off a grid item's stretch, so
   each card shrank to fit its content: a long name made a 200 px card next to 120 px ones. The
   `aspect-ratio: 3/4` then turned the width differences into height differences.
2. **The skeleton was about half a card.** It was a bare `.app-pos-card` div with no content,
   so it collapsed to `min-height × 3/4`. The grid jumped when the catalog arrived.
3. **The narrowest cards clipped their price** on a phone (`Plain Fries` at 87.7 px wide).
4. **CardContent padding leaked in from 640 px up.** The tile's `p-2` didn't override
   CardContent's `sm:p-6 sm:pt-0`. The text block had 0 px top and 24 px side padding, which
   left a name about 106 px.
5. Not causes: slow or broken images didn't move cards (the image area was already reserved).
   A background refresh kept the cards on screen, but nothing showed it was refreshing.
6. Separate bug, fixed here: **the offline catalog cache wasn't scoped to a branch.**
   `cacheProductCatalog` upserted rows keyed by product id and never removed any. While the live
   catalog loaded, or when offline, the terminal fell back to every product ever cached on that
   device. That included another branch's products and prices, and products since taken off POS.

### What changed

- `globals.css`: `.app-pos-card` is `width: 100%` (still capped at 200 px and centred), so
  every card in a layout has the column's width. `.app-pos-card-image` has a fixed
  `aspect-ratio: 16/9` and `flex: none`.
- `components/pos/product-card-layout.ts`: one set of box classes (`POS_CARD_CLASSES`) for the
  card and the skeleton. The text rows have fixed heights: two lines for the name, one each for
  size and price, and one for the unavailable reason. A card's height is the image area plus a
  fixed text block, so it depends only on the card's width.
- `ProductCard`: the photo, the placeholder (no photo or a failed one) and the skeleton fill
  the same image area. Badges stay absolutely positioned. Truncated name, size and reason keep
  their full text in the accessible label (unchanged) and a `title`. The tile body is a plain
  div with the shared classes, not CardContent. Selection, stock guards, keyboard handling,
  `aria-disabled`, memoisation and image retry on a new signed URL are unchanged.
- `ProductCardSkeleton`: built from the same classes as the card.
- Terminal: the loading grid uses `ProductCardSkeleton`. A background refetch keeps the cards
  and shows an overlay "Updating…" pill that's absolutely positioned, so it never moves the
  grid. If a refresh fails while a saved catalog is on screen, the pill says "Showing the last
  saved catalog" with a Retry button, instead of presenting it as current. First-load loading,
  error-with-nothing-to-show and empty states are unchanged and stay distinct.
- Offline cache (`lib/offline/cache.ts`): rows are keyed `<branchId>:<productId>` and carry
  `branchId`. Each refresh replaces that branch's whole snapshot inside a transaction. Reads
  return only the requested branch. Rows from before P39 have no branch, are never served, and
  are dropped on the next refresh. `branchId` is not indexed, so Dexie needs no schema version
  bump. The terminal tags its fallback state with the branch it was read for, so a branch change
  never shows the previous branch's cached products.

### After (same probe, built code)

| Layout | Card widths | Card heights | Skeleton vs card | Moved by images / refresh |
| --- | --- | --- | --- | --- |
| 1366×768 laptop | 153.8 (all) | 211.4 (all) | 153.8×211.4 vs 153.8×211.4 | none / none |
| 1920×1080 desktop | 187.5 (all) | 230.3 (all) | 187.5×230.3 vs 187.5×230.3 | none / none |
| 1024×768 touch | 168.6 (all) | 219.7 (all) | 168.6×219.7 vs 168.6×219.7 | none / none |
| 390×844 phone | 180 (all) | 226.1 (all) | 180×226.1 vs 180×226.1 | none / none |

No price was clipped at any layout. Each refresh fired exactly one catalog request, the cards
stayed on screen, the "Updating…" pill appeared, and the newly published product joined the grid
without moving existing cards. The geometry comes from `getBoundingClientRect` on every card
before and after each step. Screenshots are illustration only; they don't prove the refresh
behaviour.

## 2. Supervisor Products page

### State semantics (inspected, not assumed)

- `Product.status` is draft | active | temporarily_unavailable | discontinued | archived.
- The builder creates products with `status: 'active'`. Its "draft" means every branch row is
  still `is_available = false` (it never changes the status; see the P36R comment in the builder).
- No "ever published" column exists. A builder draft and a product later taken off POS
  everywhere look the same on the product row. The difference is history: every availability
  change is audited against the availability row (publish through the audit outbox, unpublish and
  per-branch status changes through `recordAuditLog`), and global lifecycle changes are audited
  against the product.

### Tabs (server-side, `GET /api/products?branch_id=&view=`)

Scope is products configured at the selected branch (they have a `branch_product_availability`
row there). The branch is the one picked in the sidebar's branch selector, and the server checks
it with `hasBranchAccess` (403 otherwise).

- **Drafts**: `status = 'draft'`, or `status = 'active'`, on POS at no branch, and no
  availability or lifecycle audit entry (checked in both `audit_logs` and `audit_outbox`, in
  any outbox status; see section 7).
- **Active**: not a draft, `status = 'active'` and available at this branch. This is the same
  rule the POS catalog uses.
- **Inactive**: everything else configured at the branch. That covers off POS here, temporarily
  unavailable, discontinued and archived. Rows keep their real status: the chip says
  Archived, Discontinued, Temporarily unavailable, or "Off POS at <branch>".

A product is in exactly one tab for a branch. The response carries `counts` for all three tabs,
computed with the same search and category filters, and pages are ordered by name then id so
they never repeat or skip rows. Without `branch_id`, the endpoint is unchanged (no counts), and
the Super Admin page is unaffected.

### Rows and actions

Each row shows a thumbnail or fallback, the name (a link to the product page), the category, the
branches it's set up for (green when on POS there; three shown, then "+N more"), a status chip,
and direct actions. Nothing interactive is nested inside another interactive element.

- Drafts get **Continue Setup**. It reopens the existing builder draft (`loadExisting` +
  `/supervisor/products/builder?product_id=`) with its saved branches and sizes.
- Active and Inactive rows get **Edit**, which opens the popup. Active rows also get
  **Deactivate**. Inactive rows get "Publish at <branch>…", which opens the popup on Branches.
- The menu has "Open product page" and "Archive or delete…".
- Authority follows the existing rule, now shared as `lib/product-authority.ts` and also used by
  the product page. Editing, publishing, archiving and deleting need an assignment covering
  every branch the product is set up for. Deactivating at the selected branch needs only an
  assignment there (the unpublish route's `branchGuard`). A product the supervisor can't edit
  shows "Set up for a branch outside your assignment — view only." and a View link to the product
  page, where Create Branch Copy lives. The menu explains why Archive and Delete aren't offered.
  The server still re-checks every write.
- Search and the tab counts use the server's filters. Rows from another branch or another tab
  are never shown under the current tab while it loads; a skeleton shows instead. After a
  reload, the branch name comes from the selector's cached branch list (only the id is
  persisted).

## 3. Edit popup

One dialog with Details | Sizes & Prices | Ingredients | Choices | Branches, built from the
existing editors and hooks.

- **Details** is staged. Nothing is sent until **Save details**, and **Discard changes**
  restores the saved values. The save carries the version the form was loaded from
  (`expected_version`). A newer save elsewhere is refused (409 `PRODUCT_CONFLICT`); the typed
  values stay, and "Load latest (discards your changes)" is offered. A newer version that
  arrives while nothing is typed refreshes the fields. Validation errors stay inline. The
  photo is a separate section labelled "Saves as soon as you upload or remove it".
- **Sizes & Prices** (`ProductSizesPanel`, now shared with the builder), **Ingredients**
  (`RecipeBomPanel` per size), **Choices** (`VariantChoicesCard`, moved out of the builder:
  flavors, option groups, Mix & Max slots) and **Branches** (per-branch On POS / Not on POS,
  Deactivate here, and Publish here gated on the server's publication check with P38R3's Check
  again) all save each action as it's confirmed, as they did before. Each tab says so. Deleting
  a size asks first in the popup; the builder's draft keeps its direct delete.
- The footer button is **Close**. There's no Cancel, because saved sections can't be undone.
  Closing with unsaved details, or with a section form open, asks "Discard and close" or "Keep
  editing".
- **No stacked dialogs.** `ui/dialog.tsx` gained `DialogHost`. Inside the popup, any dialog a
  section opens (Add Size, recipe line, inline new inventory item, flavor link, option group,
  slot, snack option, confirmations, including `ConfirmDialog`) renders as a non-modal panel
  over the tab content. There's one overlay and one focus trap. Escape closes only the top
  panel. Clicks on the popup's header don't dismiss a half-filled form. The content underneath
  is `inert` while a panel is open, the tabs are locked so a panel can't be unmounted with its
  input, and focus returns to the control that opened it. A panel's close button is labelled
  "Close this form", so it isn't confused with the popup's Close. Outside a host, every dialog
  in the app is unchanged.
- The product page (`/supervisor/products/[id]`) still exists, with Change Status, Restore and
  Create Branch Copy.

## 4. Deactivate, Archive, Delete

- **Deactivate** (row or Branches tab) is the existing per-branch unpublish. The confirmation
  names the branch and lists the branches where the product stays on POS. It never changes
  `Product.status`.
- **Archive** is the existing global lifecycle change. The dialog says it takes the product off
  POS at every branch (and names them), keeps sales, receipts, stock and history, can be
  restored, and that Deactivate is the per-branch option.
- **Delete permanently** is the existing `DELETE /api/products/:id` and needs DELETE typed. The
  server deletes only availability rows, variants and their flavor links. Recipe components,
  inventory links, option-group assignments, change logs, transaction items and held items all
  reference the product or variant with restrict foreign keys, so any of them makes the server
  refuse with `PRODUCT_HAS_DEPENDENCIES`. The dialog then says why, and offers Archive. No
  endpoint was added or loosened. Stock, sales, receipts, deductions and audit history are never
  removed.
- Branch-copy and replacement protections are untouched. Restore stays on the product page,
  with its existing cascade that skips replaced branches.

## 5. Verification

All against local services only: Postgres `127.0.0.1:5432/pos_verify` (checked before running),
local Supabase storage `127.0.0.1:54321`, built API on `:4000`, and `next start` on `:3000`.

### Real browser (Playwright, built web + built API)

`tests/e2e/pos-perf-p39-products-management.spec.ts`, project "Admin Dashboard (Desktop)", one
worker: **4 passed (6.2 min)**. It seeds its own branches A and B, a supervisor assigned to
both, and five products, then checks:

1. Tabs and counts at branch A (Active 1, Drafts 2, Inactive 2). Each row shows the right chip
   (On POS, Draft, Archived, "Off POS at A"), drafts offer Continue Setup, and the layout has no
   horizontal overflow at 1440, 820 and 390 px.
2. The Edit popup. A staged Details save, then a discarded edit on Close ("Discard and close");
   the server keeps the saved name and not the discarded description. Add Size opens inside
   the popup (one overlay, tabs locked) and saves on its own. On Ingredients and Choices, Add
   Component, Assign Option Group and Add Slot open as panels inside the popup, and Escape
   closes only the panel. Keyboard focus stays inside the popup. Deactivate on the Branches tab
   names the branch, takes the product off POS at A only, moves it Active → Inactive (counts
   0 / 2 / 3), and the POS catalog for A no longer lists it.
3. Phone (390×844). The popup fits the screen and Close stays reachable from the Choices tab.
4. Delete permanently (DELETE typed) removes a draft nothing refers to; the API then returns
   404 for it. For the configured product it is refused, because recipe lines refer to it; the
   dialog says why and offers Archive. Archive gives the row the Archived chip, and the server
   shows status `archived` with all three sizes kept. Continue Setup reopens the saved builder
   draft with both of its branches and its saved size.

Earlier runs of this spec failed for reasons that were fixed or are environmental:

- **A real bug, fixed:** right after a successful Save details, typing again flashed a false
  "changed elsewhere" notice until the refetch arrived (the form compared versions with `!==`).
  It now only treats a strictly newer version as a change elsewhere, and there's a unit test
  for that window.
- **Test harness:** the post-login redirect could land after the test's own navigation, and the
  phone check measured during the open animation.
- **Environmental:** page reloads under heavy CPU load hit the pre-existing token-refresh
  timeout described under Limitations. The spec now navigates in-app.

### POS card probe

The geometry table in section 1. All four layouts were measured on the final build.

### Automated tests

| Check | Result |
| --- | --- |
| API tests (`apps/api`, vitest) | 172 files passed, 16 skipped (environment-gated); 2961 tests passed, 232 skipped |
| — new `products.branch-views.integration.test.ts` (real Postgres) | 7 / 7 |
| — `products.router.test.ts` / `products.service.test.ts` | 26 / 26, 164 / 164 |
| Web tests (`apps/web`, vitest) | 148 files, 1273 tests, all passed |
| — new: card skeleton 9, offline cache 3, dialog host 4, Products page 9, details form 7, editor 5 | all passed |
| Shared tests (`packages/shared`) | 4 files, 30 tests, all passed |
| Type-check: shared, API, web (`tsc --noEmit`) | clean |
| Lint: shared, API, web (`eslint .`) | 0 errors. No warnings in changed files; the 308 API warnings and 1 web warning are pre-existing |
| Builds | API `tsc` and web `next build` succeed |

## 6. Limitations

- **Draft detection depends on audit history.** No "ever published" column exists, so a
  builder draft is told apart from a product taken off POS everywhere by its audit entries
  (`audit_logs` plus `audit_outbox` in any status). If audit rows were ever purged, such a product
  would show under Drafts. No schema change was made to avoid this, as the spec preferred.
  Section 7 has the delivery-timing analysis and the one write path that can still lose this
  history.
- **Scope is the selected branch.** The tabs list products set up for the branch picked in the
  sidebar. A product not configured there doesn't appear until it is set up for that branch
  (Create Product or the product page).
- **Partial authority is view-only in the list.** A supervisor whose assignment doesn't cover
  every branch a product is set up for can deactivate it at their branch but sees View instead
  of Edit, and is told why Archive and Delete aren't offered. That path is covered by unit
  tests, not by a browser test with a second supervisor.
- **Restore** of an archived product stays on the product page; the list doesn't offer it.
- **Delete permanently** only succeeds for a product nothing refers to (usually a draft). That
  is the existing endpoint's rule and wasn't loosened.
- **Pre-existing, not changed here — token refresh under load.** On a reload, the web app
  refreshes the access token. Under heavy CPU load the refresh-rotation transaction
  (`rotateRefreshTokenTx`) exceeded Prisma's 5 s interactive-transaction timeout (P2028 → 500).
  The client then logged out, and the middleware sent the still-valid session back to the
  dashboard. This was seen locally only, with the CPU at 100%. It's worth its own ticket: a
  longer `timeout` on that transaction, or a retry on P2028.
- **Pre-existing flaky test:** `app/(branch)/branch/terminal/page.test.tsx` "bounded backlog"
  can exceed its 5 s timeout on a loaded machine; it also does at the starting HEAD.
- Only the "Admin Dashboard (Desktop)" Playwright project was run for the new spec. Phone and
  tablet widths were covered inside it by resizing the viewport. The mobile/PWA projects and
  real devices weren't run.
- Local leftovers in `pos_verify`: the P39 spec and the probes created test branches (since
  deactivated), a supervisor and products whose names carry a run suffix. Nothing outside the
  disposable local database was written.

## 7. P39R — Draft classification while audit delivery is pending

Starting HEAD: `29a8bb901ff9040ea02040d2f9e35cf63d574718` (P39), clean tree. No product code,
schema or migration changed. One test file was added, and this runbook was updated. Nothing was
pushed or deployed, and nothing touched production data.

### Finding

The reported risk was that a product published and then taken off POS could be classed as a
Draft until its publication audit entries reached `audit_logs`. **It does not happen.** Audit
delivery alone, in any state, never changes a product's tab or the counts. No defect was found
on that path, so no fix was made. The new regression test is the evidence.

### Classification rules (`productsRepository.findAll` / `findDraftIds` / `branchViewOf`)

One read selects every product with a `branch_product_availability` row at the selected branch
(plus the search/category filters), with all of its availability rows at every branch. Each
product is then classified once, in memory:

1. **Drafts**: `status = 'draft'`. Or `status = 'active'`, `is_available` false at every branch,
   and no history entry. A history entry is any `audit_logs` **or** `audit_outbox` row, in any
   outbox status, with one of these targets:
   - `entity_type = 'branch_product_availability'` and `entity_id` set to one of the product's
     availability rows. This covers publication (outbox), unpublish and per-branch status changes
     (`recordAuditLog`).
   - `entity_type = 'product'` and an action in `PRODUCT_STATUS_CHANGED`,
     `PRODUCT_CATALOG_REMOVAL_CASCADE`, `PRODUCT_CATALOG_RESTORE_CASCADE` or
     `PRODUCT_REPLACED_AT_BRANCH`.
2. **Active**: not a draft, `status = 'active'` and `is_available` at the selected branch. This
   is the POS catalog's own predicate (`findCatalogForBranch`).
3. **Inactive**: every other product configured at the branch. That covers off POS here
   (including "published only at another branch"), temporarily unavailable, discontinued and
   archived. The real `status` is returned, so the chip stays explicit.

Rows, the three counts, `total` and pagination all come from that single classification (the
listed page is `id IN idsByView[view]`, ordered by the sort field and then `id`). They cannot
disagree. History is two batched queries over all candidate ids (`audit_logs`, then
`audit_outbox`), never one lookup per product. They run only for active products that are
off POS everywhere.

Branch copies (`forkProductCascade`) are created with `status = 'draft'`, so they are Drafts until
they are set active. The POS catalog requires `status = 'active'`, so a draft-status copy is never
sold, even after `replaceSharedProductAtBranch` turns its availability row on. Draft is reachable
only at creation (`GLOBAL_TRANSITIONS` has no transition back to `draft`).

### Why delivery timing cannot move a product

- `publishWithinLock` enqueues its `PRODUCT_BRANCH_AVAILABILITY_CHANGED` intents (entity = the
  availability row) **in the publication's own transaction**. When the publication is visible,
  so is its history.
- `findDraftIds` reads `audit_outbox` with **no status filter**. Pending, processing, stuck and
  delivered rows all count.
- `deliverGroup` flips the rows to `delivered` and inserts the `audit_logs` entries in one
  transaction. It never deletes outbox rows. Because a delivered entry is in both tables, the two
  non-snapshot reads cannot miss it in a race. If delivery commits between them, the outbox read
  still sees the row.
- Retention: no production code, migration, trigger or script deletes from `audit_outbox` or
  `audit_logs` (searched `apps/api/src`, `apps/api/prisma/migrations`, `scripts`). Only test
  cleanups do. **Assumption for any future retention job:** delivered outbox rows are history
  for this check, and so are `audit_logs` rows on availability rows and products. Pruning
  either one without a replacement marker would move previously published products into Drafts.

### Evidence: `products.branch-views-audit-delivery.integration.test.ts` (real Postgres)

Local `127.0.0.1:5432/pos_verify` only (host and database checked before running). Fixtures carry a
run suffix and are deleted afterwards. Delivery is paused for the file's own intents: they are
written with a far-future `next_attempt_at`, so no worker can claim them until the test releases
them. That includes the P39 probe API that was still running on `:4000` against the same database.
The first, unpaused version of this test was in fact delivered by that worker partway through.
Publication goes through the real `publishProductToBranches`. Deactivation goes through the real
`unpublishProduct`, with **every `audit_logs` insert failing** (the direct writer swallows the
error), so the outbox is the only history left.

| Stage | P (published at A+B) outbox | A: Active / Drafts / Inactive | B: Active / Drafts / Inactive |
| --- | --- | --- | --- |
| Genuine draft + P just published | pending, nothing in `audit_logs` | P / draft / — | P / draft / — |
| P off at A (audit_logs down) | pending | — / draft / P | P / draft / — |
| P off at both; Q published at B only; L has history in `audit_logs` only | pending | 0 / 1 / 3 (L, P, Q) | 1 (Q) / 1 / 1 (P) |
| P's group claimed, not delivered | processing | 0 / 1 / 3 | 1 / 1 / 1 |
| P's group exhausted (`recordFailure` → stuck) | stuck | 0 / 1 / 3 | 1 / 1 / 1 |
| Requeued and delivered (P and Q) | delivered, one `audit_logs` entry per row | 0 / 1 / 3 | 1 / 1 / 1 |
| P archived, Q discontinued | — | 0 / 1 / 3, real status kept | 0 / 1 / 2 (`archived`, `discontinued`) |
| P restored | — | P Active | P Active |

Every stage also checks that the counts are the same on all three tabs and that `total` equals
the listed rows.

| Check | Result |
| --- | --- |
| New file, serial with `products.branch-views` + `audit-outbox` integration suites | 3 files, 22 / 22 passed |
| New file, those three files in parallel with the `:4000` worker polling | 12 runs. The new file passed in all 11 where per-file results were captured; one run had a failure without the failing file recorded |
| `app/(supervisor)/supervisor/products/page.test.tsx` (tabs/counts UI) | 9 / 9 passed |
| API `tsc --noEmit`; `eslint` on the new file | clean |

No UI or API behaviour changed, so no new browser run was needed. Section 5's browser spec
already covers Deactivate moving a product from Active to Inactive.

### Migration and rollout

None. No schema, no data backfill, no change to publication, checkout, stock deduction or
audit delivery.

### Remaining limitations (concrete)

- **Best-effort history on the direct availability paths.** `updateBranchProductAvailability`,
  `bulkUpdateBranchProductAvailability`, the branch-scoped `changeProductStatus`,
  `replaceSharedProductAtBranch` and the restore cascade commit first. They then write their
  audit entry with `recordAuditLog`, which logs and swallows errors. Suppose a product is turned
  on **only** through one of these paths, that one audit write fails, and the product is later
  taken off POS at every branch. It then reads as a Draft (Continue Setup). The tested pending
  publication, by contrast, stays Inactive. Products published through Add to POS or Publish
  here (the outbox path) are not affected. Closing this would need either the outbox on those
  paths (a change to audit delivery, out of scope here) or an additive "ever on POS" marker on
  `branch_product_availability`, set in the same statement that turns a row on. A marker could
  be backfilled reliably only from `is_available = true` and existing history entries, and
  carries no fabricated date. Not done; it needs a decision.
- **Pre-existing flaky test:** `audit-outbox.integration.test.ts` "concurrent workers alongside
  concurrent legacy audit writers" sometimes fails when run in parallel with other database
  suites. It failed once in 3 parallel runs of only the HEAD files, and in some runs with the new
  file. It passed every serial run. Not changed here.
- Local leftovers: the P39 `dist/server.js` on `:4000` and `next start` on `:3000` are still
  running against `pos_verify`. They were not stopped.
