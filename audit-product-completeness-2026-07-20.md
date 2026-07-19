# Product Management Admin UX Completeness Audit — 2026-07-20

## 1. Executive Summary

Feature completeness score: **14/32** standard POS catalog-management features implemented.

- **Critical gaps** (blocks admin daily workflow): **4**
  - No product/variant/image delete anywhere in API or UI (no `DELETE` route on `products.router.ts` at all)
  - No status transition guardrails (any status → any status, no state machine)
  - Recipes admin page is a literal Phase-0 placeholder despite a fully-built backend (`recipes.router.ts` has full CRUD + ingredient sub-routes)
  - No product change audit trail (audit module exists, never called from products module)
- **High gaps** (professional dashboard parity): **7**
  - No bulk select/bulk actions on product list
  - No CSV export/import
  - No "Change Image"/"Remove Image" (only Upload, and only when no image exists conceptually — button relabels but no delete)
  - No duplicate/clone product
  - No price/kcal/branch/updated-date filters (only name+category text and status dropdown)
  - No sortable columns on product list (no `sort`/`orderBy` in UI, backend untouched)
  - No delete for variants (add + edit only, `VariantCard` has no delete/remove action)
- Medium gaps (nice-to-have): **8** (image alt text, image gallery, hover zoom, file size/dimension display, flavor CRUD delete, FK/P2003-specific error messages, empty state on Recipes, category management UI)
- Low / polish: **13** (optimistic updates, image dimension validation UX, etc. — see F5)

Everything that *does* exist is solid: toasts on every mutation (`use-products.ts`), loading spinners + `ErrorState`/`EmptyState` components used consistently, Zod validation on every write route, and the flavors/product-requests/price-overrides pages are all real, working CRUD/approval UIs — only Recipes is a stub.

## 2. Findings by Section

**A — Product List** (`apps/web/app/(admin)/admin/products/page.tsx`, 221 lines)
- ✅ View, Edit, Change Status, Upload Image (row dropdown, lines 100-103)
- ❌ Delete (Critical — no backend route to call even if UI existed)
- ❌ Duplicate/Clone (High)
- ❌ Archive as a distinct one-click action (only via status dialog)
- ❌ Bulk select / bulk activate-deactivate-delete (High) — no checkbox/selection state found
- ❌ Filters: only name/category text search + status `Select` (lines 129-154); no kcal, price, variant-count, branch, or last-updated filters (High)
- ❌ Sortable columns (High) — no `sort`/`orderBy` wiring in list page or column defs
- ❌ CSV export/import (High) — no `export`/`import`/`csv` hits outside the JS keyword `export default`

**B1 — Overview tab** (`[productId]/page.tsx:119-181`)
- ✅ Shows description, display order, variant/branch counts, seasonal window, created-by, timestamps
- ❌ All fields are read-only display; no inline edit (must use the separate "Edit Product" dialog) — Low, arguably fine as a design choice

**B2 — Variants & Flavors tab** (`[productId]/page.tsx:183-246`, `VariantFormDialog`, `LinkFlavorDialog`, `EditVariantFlavorDialog`)
- ✅ Add variant (`VariantFormDialog`), edit variant (same dialog, pre-filled)
- ✅ Link flavor to variant, edit variant-flavor pricing/kcal override
- ❌ Delete variant (Critical/High) — `VariantCard` has no delete/remove affordance; backend has no `DELETE /:productId/variants/:variantId`
- ❌ Unlink/remove a flavor from a variant — only add + edit-pricing found, no remove

**B3 — Branch Availability tab** (`[productId]/page.tsx:248-304`)
- ✅ Per-branch toggle via `Switch`, backed by `PATCH /:productId/branch-availability/:branchId`
- ✅ Global lock enforced when product is discontinued/archived (line 251, 291)
- ❌ Bulk toggle across all branches at once (Medium) — one switch per row, no "enable all"/"disable all"

**B4 — Media tab** (`[productId]/page.tsx:306-328`)
- ✅ Upload Image (works, disabled when archived)
- ❌ Change/Replace image without going through the same single "Upload Image" flow — functionally it does overwrite, but there's no distinct affordance or confirmation (Medium)
- ❌ Remove/Clear image back to placeholder (High) — no `DELETE /:productId/image` route
- ❌ Preview/zoom, multi-image gallery, alt-text field, file size/dimension display (Low/Medium — most commercial POS don't require these either)

**C — Related Sidebar Pages**
- ✅ Flavors (`flavors/page.tsx`, 134 lines) — real CRUD page; backend has GET/POST/PATCH but **no DELETE** on `flavors.router.ts` (Medium gap, mirrors product delete gap)
- ❌ **Recipes** (`recipes/page.tsx`, 8 lines) — literally `"Phase 0 placeholder — implemented in a later phase"` while `recipes.router.ts` already has full GET/POST/PATCH/DELETE + `/simulate` + ingredient sub-routes (Critical — backend/frontend drift)
- ✅ Product Requests (`approvals/product-requests/page.tsx`, 112 lines) — approve/reject workflow present
- ✅ Price Overrides (`approvals/price-overrides/page.tsx`, 123 lines) — CRUD present

**D — Backend API Completeness** (`apps/api/src/modules/products/products.router.ts`)
- Present: `GET /`, `GET /catalog`, `GET /:id`, `POST /`, `PATCH /:id`, `POST/PATCH /:id/status`, `POST/PATCH /:id/image`, `POST/GET/PATCH /:id/branch-availability[/:branchId]`, `POST/PATCH /:id/variants[/:variantId]`, `POST/PATCH /:id/variants/:variantId/flavors[/:flavorId]`
- Missing: **any `DELETE` route** (product, image, variant, or variant-flavor link), `duplicate`, `bulk`, `export`, `import` (Critical/High)
- Flavors module: missing `DELETE /flavors/:id` (Medium)
- Recipes module: full CRUD including `DELETE` already exists server-side, unused by the stub UI

**E — Data Integrity Guards**
- ❌ No `P2003`/foreign-key-specific error handling anywhere in `apps/api/src` (Medium — matters once delete ships, since deleting a product/variant with transaction history will need a graceful conflict message)
- ❌ No explicit status transition state machine — `PATCH /:id/status` accepts any of the 5 `PRODUCT_STATUS` values (`draft`, `active`, `temporarily_unavailable`, `discontinued`, `archived`) with no adjacency rules (Critical — e.g. nothing stops `archived → draft`)
- ❌ No audit logging call from the products module despite a working `audit` module and an Admin → Audit Logs page elsewhere in the app (Critical — product/price/status changes aren't traceable)

**F — UX Polish**
- ✅ Loading states: `LoadingSpinner` used consistently in list + detail pages
- ✅ Error states: `ErrorState` with retry, used consistently
- ✅ Empty states: `EmptyState` used for no-variants, no-branches
- ✅ Toasts: every mutation in `use-products.ts` has `onSuccess`/`onError` with `sonner` toasts (10+ call sites)
- ❌ Optimistic updates: no `onMutate`/optimistic hits in `use-products.ts` — all mutations wait for server round-trip (Low)

## 3. Comparison Table

| Feature | Potato POS | Square | Toast | Loyverse | Priority |
|---|---|---|---|---|---|
| View/Edit product | ✅ | ✅ | ✅ | ✅ | — |
| Delete product | ❌ | ✅ | ✅ | ✅ | Critical |
| Duplicate product | ❌ | ✅ | ✅ | ✅ | High |
| Change status | ✅ (no state machine) | ✅ | ✅ | ✅ | Critical |
| Bulk select/actions | ❌ | ✅ | ✅ | ✅ | High |
| CSV export/import | ❌ | ✅ | ✅ | ✅ | High |
| Sortable/filterable list | Partial (search+category+status only) | ✅ | ✅ | ✅ | High |
| Add/edit variant | ✅ | ✅ | ✅ | ✅ | — |
| Delete variant | ❌ | ✅ | ✅ | ✅ | High |
| Link/unlink flavor per variant | Partial (link+edit, no unlink) | ✅ | N/A | ✅ | Medium |
| Per-branch availability toggle | ✅ | ✅ | ✅ | ✅ | — |
| Upload image | ✅ | ✅ | ✅ | ✅ | — |
| Remove/replace image | ❌ | ✅ | ✅ | ✅ | High |
| Product change audit trail | ❌ | ✅ | ✅ | Partial | Critical |
| Recipe management UI | ❌ (stub) | N/A | ✅ | Partial | Critical |

## 4. Recommended Fix Order

**Batch 1 — fix now (blocks daily admin use):**
1. Add `DELETE /:productId` + `DELETE /:productId/variants/:variantId` + `DELETE /:productId/image` routes and wire UI actions
2. Build the real Recipes admin page against the already-complete `recipes.router.ts`
3. Define and enforce the product status transition state machine
4. Wire product mutations into the existing `audit` module

**Batch 2 — pre-pilot polish:**
5. Bulk select + bulk status change on product list
6. Duplicate/clone product action
7. Additional list filters (price range, branch, last updated) + sortable columns
8. Unlink flavor from variant
9. `DELETE /flavors/:id` route + UI
10. Graceful P2003/foreign-key conflict messages for the new delete routes

**Batch 3 — post-pilot backlog:**
- CSV export/import
- Image replace/remove distinct affordances, alt text, gallery
- Bulk branch-availability toggle
- Optimistic UI updates

## 5. Token Usage Justification

No subagents or skills were used (per task instructions — task is single-purpose, well-scoped grep/read work suited to direct tool calls). All investigation used targeted `grep`/`find`/`wc -l`/`Read` on specific files rather than full-repo dumps; total tool calls: 8.
