# Admin Product Catalog Audit — 2026-07-19 (Phase 21 pre-flight)

Findings only. No fixes applied.

## 1. EXECUTIVE SUMMARY

**Critical (blocks Phase 21 rollout): 2**
- Row actions menu only wires "View" — Edit/Deactivate/Upload Image dialogs and hooks already exist but aren't connected to the list row (pure wiring gap, no missing backend work).
- Product image upload fails server-side (`IMAGE_UPLOAD_FAILED`, 502) — confirmed via prod logs as an application-level Supabase Storage error, root cause unconfirmed pending Supabase dashboard check (no server-side error logging exists to reveal Supabase's actual error text).

**High (blocks admin usability): 2**
- "Duplicate" is a genuinely missing feature — no API endpoint, no hook, no dialog anywhere in the codebase.
- Storage upload errors are swallowed with zero logging (`products.service.ts:543`), making any future upload failure undiagnosable from logs alone.

**Medium (backlog): 2**
(Bucket provisioning for `product-images` is undocumented/uncoded — must be a manual Supabase dashboard step, no migration or setup script found. "0 Active Variants" on both screenshot products is very likely just an empty state, not a bug — variant creation UI is fully wired.)

## 2. FINDINGS BY SECTION

**A — Product list UI**
- Critical — [apps/web/app/(admin)/admin/products/page.tsx:96-97](apps/web/app/(admin)/admin/products/page.tsx#L96-L97): `DropdownMenuContent` contains exactly one `DropdownMenuItem` ("View"). No role check is involved — the other items were simply never added. Fix: add items that open the already-existing `EditProductDialog`, `ChangeProductStatusDialog`, and `UploadProductImageDialog` components.
- No role/permission conditionals found in this directory (A4) — rules out a broken role gate as the cause.

**B — Product CRUD API**
- All expected verbs exist and are correctly guarded: `GET /` (list, admin/supervisor), `GET /:productId`, `POST /` (super-admin only — supervisors get `USE_PRODUCT_REQUEST` redirect per CR-001), `PATCH /:productId` (update, admin-only), `PATCH /:productId/status` (soft-delete/status-change pattern, admin/supervisor + branchGuard). [apps/api/src/modules/products/products.router.ts:77-360](apps/api/src/modules/products/products.router.ts#L77-L360)
- No hard `DELETE /:productId` route exists — by design, status is `active/discontinued/archived` (soft-delete via status field, not `deletedAt`). Not a bug; confirm the intended list-menu action is "Deactivate/Archive," not "Delete."
- Variant and branch-availability endpoints also fully present (POST/PATCH variants, variant-flavors, branch-availability).

**C — Frontend hooks**
- All corresponding hooks already exist in [apps/web/hooks/queries/use-products.ts](apps/web/hooks/queries/use-products.ts): `useCreateProduct`, `useUpdateProduct`, `useChangeProductStatus`, `useUploadProductImage`, `useBranchProductAvailability`, `useUpdateBranchProductAvailability`.
- `page.tsx` only imports `useProducts` (list) — none of the mutation hooks are imported into the list page. No dead imports; the gap is an omission, not a broken reference.
- No `useDeleteProduct` or `useDuplicateProduct` hook exists anywhere (consistent with B's finding — no backend support for either).

**D — Image upload pipeline (see root cause section below)**
- Frontend, multer, and sharp compression are all correctly wired: [apps/api/src/modules/products/products.router.ts:192-230](apps/api/src/modules/products/products.router.ts#L192-L230) (multer memory storage, 5MB limit, adminOnly), [products.service.ts:527-549](apps/api/src/modules/products/products.service.ts#L527-L549) (sharp resize→webp→Supabase upload).
- Sharp `^0.35.3` is installed. `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are required+validated in [config/index.ts:35-36](apps/api/src/config/index.ts#L35-L36) (app would fail to boot if unset — rules out "env var entirely missing," but doesn't rule out wrong value).
- **Bug:** [products.service.ts:543](apps/api/src/modules/products/products.service.ts#L543) — `if (error) throw new ProductError('IMAGE_UPLOAD_FAILED', ...)` discards the actual Supabase error object. No `logger`/`console` call exists anywhere in this service file. The real cause (bucket-not-found, RLS, auth) is invisible in logs.
- No reference to `product-images` bucket creation in Prisma migrations or `docs/` — bucket appears to be a manual, undocumented Supabase dashboard artifact.

**E — Product variants**
- Variant CRUD is fully wired: `VariantFormDialog` is imported and rendered on the product detail page ([apps/web/app/(admin)/admin/products/[productId]/page.tsx:22,218](apps/web/app/(admin)/admin/products/%5BproductId%5D/page.tsx#L218)), backed by `POST/PATCH /:productId/variants`. "0 Active Variants" is very likely a true empty state for those specific products, not a broken flow — recommend confirming with user before treating as a bug.

**F — Branch scoping**
- Model exists and is wired correctly: `branchExclusive` / `exclusiveBranchId` fields in both [products.types.ts:24-25](apps/api/src/modules/products/products.types.ts#L24-L25) and [prisma/schema.prisma:365-369](apps/api/prisma/schema.prisma#L365-L369), with a proper `Branch` relation. No issue found.

**G — Render log check for upload error**
- API service: `srv-d9cok48js32c73dss310` (potato-corner-web-pos-main).
- Found the exact failing request in recent logs:
  `POST /api/products/35359932-ecd6-4778-ae32-f8facf1fc59a/image` → **502**, response body **111 bytes**.
- Verified `111` bytes is an exact byte-for-byte match for the app's own error JSON:
  `{"data":null,"error":{"code":"IMAGE_UPLOAD_FAILED","message":"Failed to upload the product image"},"meta":null}`
  → This is confirmed as an **application-level** failure inside `uploadProductImage` (Supabase Storage `.upload()` returned an error), not a Render platform/deploy-timing 502, despite occurring near a concurrent deploy.
- No Supabase-specific error text is visible in logs (per the D-section logging gap) — can't yet distinguish bucket-not-found vs. auth vs. RLS from logs alone.
- Render CLI in this environment has no `env`/`ea` subcommand for listing service env vars by name (`render ea` is object storage/sandboxes only) — could not independently confirm `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` values are correct for this environment via CLI. Recommend checking directly via the Render dashboard.

## 3. IMAGE UPLOAD ROOT CAUSE

Ranked hypotheses (given confirmed evidence: sharp compression path never errors independently in logs; failure is inside the Supabase `.upload()` call itself):

1. **Bucket `product-images` doesn't exist in the target Supabase project** (or exists under a different name/casing). Highest likelihood — no migration, seed script, or doc references bucket creation anywhere in the repo, so it was never provisioned as code.
2. **`SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_URL` on Render points at the wrong Supabase project** (e.g., a stale key from before a project rotation) — env vars are present (app boots) but could be pointing at an environment without this bucket.
3. **Bucket-level policy/RLS misconfiguration** blocking even the service-role client — less likely, since service role normally bypasses Storage RLS, but possible if the bucket was created with unusual owner/policy settings.

**Exact next step to confirm:** add a one-line `console.error` (or logger call) around [products.service.ts:543](apps/api/src/modules/products/products.service.ts#L543) logging `error.message`/`error.statusCode` from the Supabase response, deploy, reproduce the upload once, then re-check `render logs -r srv-d9cok48js32c73dss310 --status-code 502`. Alternatively, skip the code change and directly check the Supabase dashboard's Storage tab for a `product-images` bucket in the project referenced by the production `SUPABASE_URL`.

## 4. RECOMMENDED FIX ORDER

**Fix now (blocks admin workflow):**
- Wire Edit/Deactivate/Upload-Image `DropdownMenuItem`s into the list row menu using the already-existing hooks/dialogs (no new components needed).
- Add error logging to `uploadProductImage` so the real Supabase error is visible, then diagnose and fix the actual storage failure (bucket/env/policy per hypotheses above).

**Fix before Phase 21 catalog ingestion:**
- Decide whether "Duplicate" is in scope for Phase 21; if yes, it requires new API endpoint + hook + dialog (currently 100% absent, not partially built).
- Document/script the `product-images` Supabase bucket provisioning so it isn't a tribal-knowledge manual step.

**Backlog:**
- Confirm with user whether "0 Active Variants" on the two screenshotted products is expected (true empty state) — variant creation flow itself is fully functional.

## 5. TOKEN USAGE JUSTIFICATION

No subagents, MCP, or skills used — direct Read/Grep/Glob/Bash only, per instructions. Initial path assumptions in the brief (`apps/web/app/admin/...`, generic `<SERVICE_ID>`) were wrong for this repo's actual layout (nested repo root, route group `(admin)`, Render service ID unknown) and had to be discovered with two extra `find`/`render services list` calls before the scoped greps could run; all other steps followed the brief's plan directly. `render logs`/`render ea` flag syntax also differed from the brief's assumed syntax and required two `--help` lookups to correct.
