# POS-PERF-P69 — product type filter and badges on the POS

Cashiers could only see a product's **size** on a POS card. "Cheese Fries PPO" is Promotional in Supervisor Products, but its card showed only "Regular", which is the name of its size, and could be mistaken for its type. The POS Products view now has a labelled **Type** filter and a type badge on every card. Type, category and search work together.

| | |
|---|---|
| Starting SHA | `a5ffefbb` (origin/main, PR #49 merge, the last **reported** deployment, not verified here) |
| Branch | `feat/pos-perf-p69-pos-product-type-filter` (pushed with a PR to `main` after P69R; not merged or deployed) |
| Tested / final SHAs | See §7 |
| Schema / migration | **None.** Additive response fields only |

## 1. Three different things

| | Examples | Where it comes from | On the POS |
|---|---|---|---|
| **Type** | Regular, Promotional, Seasonal, Marketing | P58: a custom assignment (`products.product_type_id`), else the built-in named by `classification` | Type filter row and the card badge (new) |
| **Category** | Flavored Fries, Drinks | `ProductCategory` (active), else the legacy `category` text | Category filter row (unchanged; first tab now reads **All Categories**) |
| **Size** | Regular, Large, Mega | The variant's name | The card's second line (unchanged) |

A size called "Regular" and the type Regular are unrelated. The badge never replaces or relabels the size.

## 2. Type rules (same as Supervisor Products)

- **Displayed type:** a custom assignment wins. Otherwise it is the built-in from `classification` (`is_seasonal` as the legacy fallback). This is the rule `toProductBase` uses for the Supervisor list.
- **One place per product:** a Promotional product assigned to Marketing is listed only under Marketing, never also under Promotional. Its classification and promotion eligibility are untouched (P58 §7).
- **Filter keys:** `builtin:<classification>` and `custom:<type id>`. A built-in key can't equal a custom id. A rename keeps the selection, and two types with the same name at different branches never merge.
- **Tabs:** All Types, then Regular, Promotional and Seasonal, then the branch's **active custom types scoped to this branch**, by name. A type with no POS products here still has a tab, and selecting it says "No \<Type\> products are on this POS yet."
- **Nothing was changed** to create the filter: no classification, eligibility, publication or product data.

### Deactivation (actual semantics kept)

P58 §6: deactivating a type stops new assignments and changes no product. Those products stay published and sellable. On the POS:

- the inactive type has **no tab**;
- its products stay in **All Types** (and in category or search results), with the badge showing the type name and the full label "Type: \<name\> (inactive type)";
- if that type was selected, the filter resets to All Types with a notice ("\<name\> is no longer available here. Showing All Types."), so a stale filter never hides products without explanation.

No new rule hides a product because its type was deactivated.

### Branch isolation

- The catalog route is unchanged: `authenticate`, `branchGuard`. Staff and branch accounts see only their own branch, and a supervisor only their assigned branches (403 otherwise; tested).
- The type list comes only from `product_type_branches` rows for the requested branch.
- A product's type is named only if that type is scoped to the branch. The scope invariant (P58 §5) makes the exception reachable only through an old-API rollback window. In that case `product_type` is `null`, and the card shows no badge and no guessed Regular.
- Draft or inactive products are not in the POS catalog (unchanged query: `status = active`, available at the branch).
- The web keeps the selection tagged with the branch it was chosen at. On a branch change it applies All Types at once, even before the new catalog loads. The catalog query is keyed by branch, and the offline snapshot is tagged by branch (P39), so another branch's names and products are never shown.

## 3. Filters

Type AND category AND search, all display-only (`visibleProducts` in the terminal page). Nothing is refetched, and the cart, prices, stock checks and any open customization dialog are untouched. An empty combined result shows "No products match all of these filters." with **Clear filters**, which resets all three. A search-only empty result keeps **Clear search**.

## 4. API, cache and compatibility

### Response (additive)

`GET /api/products/catalog?branch_id=` now also returns:

- `products[].product_type: { key, id, name, is_builtin, is_active } | null`
- `product_types: [{ key, id, name, is_builtin, is_active }]`

One extra query reads the active custom types scoped to the branch (`findActivePosProductTypesForBranch`), and the product query selects the type. There is no per-card request and no new realtime event. The checkout payload is unchanged.

### Refresh

New, renamed, deactivated or reactivated types and reassignments reach the branch POS through the **existing** catalog refresh. The `['catalog', branchId]` query has a 60 s stale time and refetches:

- when the terminal page mounts with stale data (returning to the terminal from another page);
- on reconnect;
- every `PRODUCT_CACHE_REFRESH_MINUTES` (30);
- on the existing stock-event invalidations.

Window-focus refetch is off app-wide (`providers.tsx`) and was left off.

**Superseded by P69R (§8):** committed product and type writes now send a branch-scoped `catalog:changed` hint, and an open terminal refetches within about 1–2 s. The 30-minute interval remains as a safety net; without realtime it drops to 2 minutes.

### Offline

- The type list is saved **beside** the offline catalog: on every `cachedProducts` row of one save (`productTypes`, outside `data`, not indexed). No Dexie version bump, so an older build can still open the database after a rollback, and it ignores the field.
- Offline, the filter and badges use the last successfully saved catalog for that branch.
- **Rows saved before P69** have neither the list nor `product_type`. The type filter is then hidden and no badge is shown; nothing is guessed as Regular. The next online refresh replaces the rows.
- Limitation: a branch with zero products saves no rows, so no type list survives offline. There is nothing to sell anyway.
- Cart, offline sales queue and unresolved operations are untouched (`offlineTransactions` and the cart store are not changed).
- No generic authenticated `/api` service-worker caching was added. The SW config is unchanged.

### Mixed versions

| Combination | Result |
|---|---|
| New web → old API | No `product_types`: the type filter is hidden and cards have no badge. Category and search work as before |
| Old web → new API | Ignores the additive fields |
| New web, pre-P69 offline cache | As above, until the next online refresh |

Deploy order doesn't matter. No migration.

## 5. Files

- **API:** `apps/api/src/modules/products/products.service.ts` (`getPosCatalog`, `toPosProductType`), `products.repository.ts` (`findCatalogForBranch` selects the type; `findActivePosProductTypesForBranch`)
- **Shared:** `posCatalogProductTypeSchema`, `PosCatalogProductType` in `packages/shared` (`product.schema.ts`, `types/index.ts`)
- **Web:** `apps/web/lib/pos/pos-product-types.ts` (keys, tabs, matching, cached-list reader), `app/(branch)/branch/terminal/page.tsx` (state, filters, tabs, empty state), `components/pos/product-card.tsx` (badge), `lib/offline/cache.ts` and `db.ts` (`productTypes` beside each row)
- **Tests:** `apps/api/src/modules/products/p69-pos-product-types.integration.test.ts`, the P69 block in `products.service.test.ts`, `apps/web/lib/pos/pos-product-types.test.ts`, the P69 blocks in `terminal/page.test.tsx`, `product-card.test.tsx` and `lib/offline/cache.test.ts`
- **Browser:** `tests/e2e/manual/p69/types.mjs`, fixtures `apps/api/scripts/p69-browser-fixtures.ts`

The card badge is read from the `product` prop the card already receives, so it adds no prop and doesn't break `ProductCard`'s memo. Cart updates don't re-render cards because of P69. The badge sits in the image area (bottom left), so the card's geometry, stock warnings, touch target and focus ring are unchanged. It has a border and text, not colour alone. Long names truncate, and the full name is in the title and in the card's accessible name ("…, Type: \<name\>").

## 6. Verification

Everything ran locally against fresh disposable embedded Postgres, sequentially. Never production, `pos_verify` or another session's services.

- **Throwaway env:** `C:\p69\env.sh` (new random keys, never printed).
- **Browser stack:** `C:\p69s` (`p62/stack.sh` with `P62_ROOT=/c/p69s`, DB `p62_p69`, ports 56691/56692/56693, outside the reserved 55158–55557).

| Check | Result |
|---|---|
| API unit, `products.service.test.ts` | 167/167 (2 new P69 tests) |
| API integration, `p69-pos-product-types.integration.test.ts` (real HTTP, real tokens) | **6/6, first run**: built-in vs custom label; empty custom type listed; size stays "Regular"; same-name types at two branches stay separate; branch B sees no A type or product; staff and supervisor without the branch get 403; rename and reassignment; deactivation keeps the product labelled `is_active: false` and drops the tab, reactivation restores it; draft product not on POS |
| Affected API: `src/modules/products` + `src/modules/product-types` | **387 passed**, 27 skipped (2 files gated). `products.integration.test.ts` (gated on the legacy `TEST_REDIS_URL`; Redis was removed in Phase 21) then run alone with a placeholder value: **22/22**. `products.publication-budget.measure.test.ts` is an opt-in benchmark, not run |
| Full API suite | Not run: an additive catalog field and one extra read; no shared API behaviour changed |
| Web, P69 terminal block | Run 1: **6/8**. Two test bugs: the search box is debounced 300 ms, and the page has several `role=status` elements. Run 2: **7/8**, a **real defect**: after a rename, the "no longer available" notice used the name from when the tab was picked. Fixed (latest seen name). Run 3: 8/8. Then a branch-switch test was added |
| Affected web (P69 helper, card, offline cache, terminal page) | 4 files, **207/207**; cache 4/4 after its P69 test |
| Full web suite | **1,815/1,815, 192 files, exit 0** (450 s, first run) |
| Shared tests | 83/83 |
| Typecheck API/web, lint | Clean; touched files 0 errors, 0 warnings |
| Production builds | API `tsc` and `next build` pass (114 s, 89 pages) |

### 6.1 Browser (`tests/e2e/manual/p69/types.mjs`)

Headless Chromium through Playwright, **emulated** viewports (desktop 1366, tablet 1024, phone 390). Production builds, service worker active and controlling the terminal. Supervisor steps used the real Products screen and product builder. The sale went through the terminal screens (P62 cashier Ana, cash).

| Run | Result | Cause |
|---|---|---|
| 1 | 0/1 | Create Product Type dialog did not close |
| 2 | 0/2 | Diagnostic: the form showed "Select at least one branch". The dialog preselects the supervisor's current branch, and the driver's toggle loop missed Main Branch. **Driver bug** → state-verified `check()`/`uncheck()` |
| 3, 4 | 1/2 | The builder saves step 1 with "Continue to Sizes & Prices", not "Save Changes". **Driver bug** |
| 5 | 20/21 | "Edit Type" not offered: the supervisor was at P62 Branch 2, and a branch-A-only type falls back to All Types there (P58 rule). **Driver bug** |
| 6 | 1/2 | The builder reopened at step 2 (it remembers the step). **Driver bug** → click "1. Product Details" |
| 7 | 15/17 | Branch B's persistent profile was already signed in (**driver bug**). Keyboard check **failed once**: focus stayed on All Types |
| 8 | 17/18 | Keyboard passed with focus confirmed before the key press and a short settle; run 7's failure was timing. Forged-request check timed out: `page.route` can't rewrite requests a service worker makes. **Emulation limit** → branch B uses a fresh profile with service workers blocked (authorization check only) |
| 9 | 20/21 | The branch switch was skipped (checked visibility before render). **Driver bug** |
| 10 | 21/22 | Offline **cold reload** showed "No branch assigned." (see limitations) |
| **11** | **24/24, exit 0** | Final |

Run 11 covered:

- the supervisor creates a branch-A-only type, then assigns a product through the builder (classification stays `regular`);
- the terminal shows the tab and badge;
- Cheese Fries PPO shows size "Regular" and the badge "Promotional";
- filters: Promotional; custom type (not under Regular); Seasonal + Drinks; + search empty → **Clear filters** resets all three;
- **ArrowRight** moves along the type tabs;
- changing filters keeps the cart line;
- a local cash sale of the custom-typed product: **one sale, ₱89.00**, stock deducted **exactly 1 and 2 units** (the recipe);
- branch B's catalog has no branch-A type or product, and a forged branch-A catalog request from branch B gets **403**;
- tablet and phone show the type row with no horizontal page scroll;
- a rename appears on the terminal after its existing refresh (returning to the terminal after the 60 s stale time);
- offline, the open terminal filters by the renamed type, and **all 33 IndexedDB rows** are branch A and carry the renamed type list.

Types from earlier runs remain as extra empty tabs in that disposable database. They correctly render as empty custom tabs.

### 6.2 Limitations

- **Offline cold reload:** investigated and fixed in P69R (§8.3). The cause predates P69.
- Branch B's authorization check ran with service workers blocked (above).
- Not run: real devices, hosted/staging (none exists), a live old-API process with the new web (covered by the "no `product_types`" unit test only), and the full API suite.
- ~~Refresh takes up to 30 minutes on an untouched terminal~~: fixed in P69R (§8).

## 7. SHAs

| | |
|---|---|
| Starting | `a5ffefbb` (origin/main) |
| Tested code, P69 | `3e21fc8f` (§6 results) |
| P69R start | `c2db620c` (the P69 docs commit) |
| Tested code, P69R | `c147ec4f` (§8 results; the browser run used the same production code, before a test-only mock fix) |
| Final | The P69R docs commit after it (see `git log`) |

**Not merged or deployed. Production not accessed.**

## 8. P69R — prompt catalog updates and the offline cold reload

The owner expects an open POS to show supervisor type and product changes without waiting up to 30 minutes, and an offline cold reload said "No branch assigned." P69R fixes both. Same branch, additive API, **no migration**, no checkout, pricing, discount or stock change.

### 8.1 Refresh mechanism

The existing Socket.io branch rooms are reused. A socket joins only its own branch rooms, from its token (`joinRoomsForUser`).

- **API, after a committed write** (`apps/api/src/lib/catalog-change-notifier.ts`):
  - It sends `catalog:changed` to each affected `branch:<id>` room. The payload is only `{ branch_id }`.
  - Branches queued within 300 ms are coalesced into one event per branch.
- **Product writes** (`products.catalog-events.ts`, mounted on the products router):
  - After any 2xx non-read request, it hints the branches with an availability row for that product. That set is exactly the branches whose POS can list it.
  - A product `DELETE` also uses the rows read before the delete.
  - A create reads the new id from its response.
  - Refused writes, reads and `/catalog/*` checks send nothing. A failed lookup only means no hint.
  - Coverage: create, publish, unpublish, availability, type reassignment, variants, flavors and options.
- **Type writes** (`notifyTypeScope` in `product-types.service.ts`):
  - Create, rename, scope widening, deactivate and reactivate hint the type's scope branches.
  - A scope never narrows (`PRODUCT_TYPE_SCOPE_NARROWING`), so the scope after the write covers every affected branch.
- **Terminal** (`useCatalogRealtimeSync` in `use-products.ts`):
  - A hint for its own branch schedules one refetch of the authorized catalog (`GET /api/products/catalog`, `authenticate` and `branchGuard`) after 750 ms. Hints for other branches and malformed payloads are ignored, and the payload is never used as data.
  - Hints that arrive in the meantime join the scheduled refetch. A fetch already in flight is never cancelled; the refetch waits for it to finish, then fetches once more.
  - It keeps one handler across reconnects and refetches once after a socket reconnect, which picks up hints missed while disconnected.
  - TanStack keeps the previous data during a refetch. Cart, customization, cashier state and queued sales are untouched, and the P69 stale-selection notice still applies.
- **Fallback:** while the socket is disconnected, `useCatalog` refetches every **2 min** instead of 30 (online and visible only; TanStack pauses it offline and in a hidden tab). That 2 minutes is the worst-case latency without realtime. It is a bounded poll, not "instant".
- **Refresh products** (terminal, beside search, accessible name "Refresh products"):
  - One network-confirmed read (`fetchConfirmedCatalog`, bypasses the service worker's copy), saved offline as usual.
  - Keeps the cart. Disabled offline. On failure it keeps the last catalog and shows an error toast.
- **Not changed:** no service-worker API caching was added and no per-card requests. Query keys stay `['catalog', branchId]`, and the identity-epoch cache clearing still applies on logout or user switch.

### 8.2 Measured update latency

Measured with `tests/e2e/manual/p69/realtime.mjs`, run 1: **22/22, exit 0**.

- **Setup:** fresh local stack `C:\p69rs`, DB `p62_p69r`, ports 56721–56723. Production builds with the service worker controlling the terminal.
- **Sessions:** the supervisor worked in a separate browser profile through the real screens. The terminal was neither reloaded nor navigated.

| Change (Supervisor screens) | Commit → open terminal shows it | Click → shows it |
| --- | --- | --- |
| Create type (branch A scope) | 1.4 s | 2.2 s |
| Assign product to the type (builder) | 1.0 s | 1.3 s |
| Rename type (selected tab kept) | 1.6 s | 1.9 s |
| Rename made while the terminal was offline | 1.2 s after reconnect | — |

- Terminal A made **6** catalog GETs for 3 changes (about 2 per change; no storm).
- Terminal B (another branch, open) made **0** and showed no branch-A type.
- Offline, the open terminal kept filtering from its saved catalog, and Refresh products was disabled.
- Refresh products returned 200 and kept the cart line.
- Sale: **one sale, ₱89.00**, stock **−1 / −2** exactly.
- Single run on emulated desktop only. Each latency is one sample, not a distribution.

### 8.3 Offline cold reload

- **Cause:** the access token and identity are memory-only by design (Architecture §5.1). An offline reload can't reach `/api/auth/refresh`, so P62 marks the session `unconfirmed` with `user = null`. The terminal (and other branch pages) then read `!branchId` as "No branch assigned".
- **Not P69:** `git diff a5ffefbb 3e21fc8f` touches none of `use-auth.ts`, `auth.store.ts`, `api-client.ts`, `branch.store.ts` or the branch layout. No pre-P69 browser build was run (no clone or new worktree), so this rests on that static evidence.
- **No offline auth mode exists.** The only persisted branch value is a sessionStorage hint, applied once a server-issued token grants it. Nothing was borrowed from caches, and no `branchGuard` or storage was bypassed or cleared.
- **The four states now:**
  - session still restoring → spinner (unchanged);
  - server unreachable or offline (`unconfirmed`) → the branch shell shows "Can't confirm your sign-in while offline" (or "Can't reach the server…"), says device data is kept, and offers **Try again**;
  - definitive refusal → sign-in;
  - a confirmed session with no branch → "No branch assigned" (a real missing assignment).
- **Recovery:** `retryUnconfirmedSession` runs on `online`, when the tab becomes visible, and on Try again (one at a time). Only a server-issued token signs the tab in.
- **Browser result:**
  - IndexedDB store counts were unchanged across the offline reload (33 catalog rows, queued sales and counters).
  - On reconnect the terminal continued by itself in **1.2 s**, without a reload.
- **Remaining limits:**
  - Selling after an offline *cold* reload is still not possible. It needs an established offline-auth design, which is a larger change and out of scope.
  - The supervisor and admin shells keep their own messages.

### 8.4 Compatibility

| Combination | Result |
| --- | --- |
| New web → old API | No hints. The terminal uses the 2-min fallback while its socket is down; while connected, only the 30-min interval, reconnect and Refresh products apply |
| Old web → new API | Ignores `catalog:changed` |
| Several API instances | Not supported for hints (in-memory Socket.io adapter, as before). Missed hints are covered by reconnect, the interval and Refresh products |

### 8.5 Tests

| Check | Result |
| --- | --- |
| API unit: notifier, product middleware, `notify` | 12/12, first run |
| API integration on a fresh embedded Postgres (port 56711): P69R hints 4/4, P69 6/6, P58 + P58R 48/48 | **58/58, first run.** Covers: type create/rename/deactivate/reactivate/widen hint only scope rooms with `{ branch_id }`; refused writes (other supervisor, staff) hint nothing; reassignment hints only the listing branch; 5 concurrent writes → one hint; reads hint nothing |
| Web: realtime sync + fallback | Run 1: 7/8, **test bug** (an unmounted hook from the previous test kept polling a shared mock). Run 2: 8/8 |
| Web: unconfirmed notice, layout, `retryUnconfirmedSession`, terminal Refresh | Notice 4/4 and layout pass. `use-auth` run 1 failed to load (my quoting error), then 19/19. Terminal P69 block 11/11 |
| Full web, run 1 | 1,831/1,835, exit 1. **1 test bug:** a shared `mockRetryOfflineSale` call leaked from P46R3; fixed. **3 timeouts** under load (658 s vs 450 s), one in an untouched file. Those files alone: terminal 182/182, manual discount types pass |
| Full web, run 2 (final code) | **1,835/1,835, 194 files, exit 0** (425 s) |
| Shared / typecheck API + web / lint (touched files) | 83/83 / clean / 0 errors |
| Production builds | API `tsc` and `next build` pass (web compile 5.9 min under load) |
| Not run | The full API suite (additive emission, affected modules run), real devices, staging, multi-instance API |
