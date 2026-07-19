# API Contracts

**Last verified:** 2026-07-20 (commit `d7a3d28`)

All endpoints below are implemented as of Phase 11 + CR-001 (see `.claude/CLAUDE.md` status line). Modules whose routers are still Phase-0 skeletons (no real routes yet — `audit`, `discounts`, `receipts`) are listed at the bottom under "Not yet implemented." `attendance`, `fraud`, `notifications`, and `reports` now have real routes (Phases 12/16/17/18) but their endpoint tables aren't written up yet — see "Also implemented" below.

## Conventions

- REST, plural nouns, no verbs in paths: `GET /api/products`, `GET /api/products/:id`, `POST /api/products`, `PATCH /api/products/:id` (not `PUT`), `DELETE /api/products/:id` (soft delete → `deletedAt`, or an approval/status field for CR-001 request tables).
- Nested resources: `GET /api/branches/:id/inventory`, `POST /api/branches/:id/inventory/adjustments`.
- Every response shape: `{ data, error, meta }` (see `app.ts` and every hand-written middleware skeleton in `apps/api/src/middleware/`).
- Every endpoint validates its payload with a Zod schema from `@potato-corner/shared` via the `validate` middleware before business logic runs; list-endpoint query params are validated inline with a router-local `z.object` schema instead (not exported from `packages/shared`, since they're route-specific view filters, not wire-format request/response shapes).
- Every protected endpoint runs `authenticate` → role guard (`adminOnly` / `adminOrSupervisor` / `supervisorOnly` / `allRoles`) → `requirePasswordChange` (+ `branch-guard` where the resource is branch-scoped, + `shift-guard` on the one route that requires an active POS shift) before the route handler. Endpoints that only have a resource id in the URL (no `branchId` in params/query/body) can't run `branchGuard` directly — those do an inline `role !== SUPER_ADMIN && !branch_ids.includes(resource.branch_id)` check after fetching the resource; this is called out per-route below.
- No direct Prisma calls in routers — always through the module's repository layer.
- Role guard legend: **admin** = `adminOnly` (Super Admin only), **admin+sup** = `adminOrSupervisor`, **sup** = `supervisorOnly`, **all** = `allRoles` (every authenticated role), **public** = no `authenticate` middleware.

## auth — mounted at `/api/auth`

| Method | Path | Access | Request schema | Notes |
|---|---|---|---|---|
| POST | `/login` | public, `loginLimiter` | `loginSchema` (`email`, `password`, `device_id`) | Sets `refresh_token` HttpOnly cookie (path `/`, not `/api/auth` — see router comment). Returns `{ access_token, user }`. |
| POST | `/refresh` | public | `refreshSchema` (`device_id`) | Reads `refresh_token` cookie; rotates it. Returns `{ access_token }`. |
| POST | `/logout` | authenticated | — | Blacklists the access token, revokes the refresh token if present. |
| POST | `/logout-all` | authenticated | — | Revokes every refresh token for the user across all devices. |
| POST | `/change-password` | authenticated | `changePasswordSchema` (`current_password`, `new_password`, `confirm_password`) | Requires `x-device-id` header. Revokes all other sessions, issues a fresh token pair. |
| POST | `/request-reset` | public, `resetLimiter` | `resetRequestSchema` (`email`) | Always returns the same generic message regardless of whether the email exists. |
| POST | `/reset-password` | public | `resetPasswordSchema` (`token`, `new_password`, `confirm_password`) | Revokes all refresh tokens for the user on success. |
| POST | `/pin/set` | authenticated | `pinSetSchema` (`pin`, 6 digits) | Requires `x-device-id` header and an existing active session on that device. |
| POST | `/pin/login` | public, `loginLimiter` | `pinLoginSchema` (`user_id`, `pin`, `device_id`) | Device must already have completed full email/password login. |
| POST | `/admin/unlock-account` | **admin** | `unlockAccountSchema` (`user_id`) | Manual override for the 5-failed-attempt lockout — clears `loginAttempts`/`lockedUntil` via the same repository call the auto-unlock-after-window path in `login()` uses. Returns `{ message: "Account unlocked" }`. |

`/refresh` rotation is guarded by a Postgres advisory lock plus a rotation-result cache (Phase 20.5, restored after an inadvertent drop in Phase 21.5, commit `6116ff1`) — concurrent refresh calls with the same stale token coalesce onto one rotation instead of racing.

## branches — mounted at `/api/branches`

| Method | Path | Access | Request schema | Notes |
|---|---|---|---|---|
| GET | `/` | admin+sup | query: `status?`, `city?`, `search?`, `page`, `limit` | |
| GET | `/:branchId` | admin+sup, `branchGuard` | — | |
| POST | `/` | **admin** | `createBranchSchema` | |
| PATCH | `/:branchId` | **admin** | `updateBranchSchema` | |
| PATCH | `/:branchId/status` | **admin** | `changeBranchStatusSchema` | |
| GET | `/:branchId/assignments` | admin+sup, `branchGuard` | — | Supervisor assignments for the branch. |
| POST | `/:branchId/assignments` | **admin** | `assignSupervisorSchema` (`userId`) | |
| DELETE | `/:branchId/assignments/:userId` | **admin** | — | 204. |
| GET | `/:branchId/stats` | admin+sup, `branchGuard` | — | |

`inventoryBranchRouter` (see the `inventory` module below) is also mounted at this same `/api/branches` prefix, contributing the `/:branchId/inventory*` routes — no path overlap with the routes above.

## products — mounted at `/api/products`

| Method | Path | Access | Request schema | Notes |
|---|---|---|---|---|
| GET | `/` | admin+sup | query: `status?`, `category?`, `search?`, `is_seasonal?`, `page`, `limit`, `sort_by?`, `sort_order?` | |
| GET | `/catalog` | **all**, `branchGuard` | query: `branch_id` | POS-facing catalog read. Registered before `/:productId` so `catalog` isn't captured as a product id. |
| GET | `/:productId` | admin+sup | — | |
| POST | `/` | admin+sup (Super Admin only in practice) | `createProductSchema` | A non-Super-Admin caller gets `403 USE_PRODUCT_REQUEST` instead of creating the product — CR-001 routes supervisors to `POST /api/product-requests` instead. |
| PATCH | `/:productId` | **admin** | `updateProductSchema` | |
| PATCH | `/:productId/status` | admin+sup, `branchGuard` | `changeProductStatusSchema` | Lifecycle state transitions. |
| POST | `/:productId/image` | **admin** | multipart `image` field (JPEG/PNG/WebP, ≤5MB via `multer`) | `422 IMAGE_TOO_LARGE` / `IMAGE_REQUIRED` / `INVALID_IMAGE_TYPE` on failure. |
| GET | `/:productId/branch-availability` | admin+sup | — | Full per-branch availability matrix. |
| PATCH | `/:productId/branch-availability/:branchId` | admin+sup, `branchGuard` | `{ is_available: boolean }` | |
| POST | `/:productId/variants` | **admin** | `createVariantSchema` | |
| PATCH | `/:productId/variants/:variantId` | **admin** | `updateVariantSchema` | |
| POST | `/:productId/variants/:variantId/flavors` | **admin** | `linkVariantFlavorSchema` | Delegates to `flavorsService`. |
| PATCH | `/:productId/variants/:variantId/flavors/:flavorId` | **admin** | `updateVariantFlavorSchema` | Delegates to `flavorsService`. |

## flavors — mounted at `/api/flavors`

| Method | Path | Access | Request schema | Notes |
|---|---|---|---|---|
| GET | `/` | admin+sup | query: `is_active?`, `search?`, `page`, `limit`, `sort_by?`, `sort_order?` | |
| GET | `/:flavorId` | admin+sup | — | |
| POST | `/` | **admin** | `createFlavorSchema` | |
| PATCH | `/:flavorId` | **admin** | `updateFlavorSchema` | |
| GET | `/:flavorId/branch-availability` | admin+sup | — | |
| PATCH | `/:flavorId/branch-availability/:branchId` | admin+sup, `branchGuard` | `branchFlavorAvailabilitySchema` (minus `branch_id`) | `{ is_available, unavailable_reason? }`. |

## recipes — mounted at `/api/recipes` (CR-001 branch overrides layered on the Phase 7 master table)

| Method | Path | Access | Request schema | Notes |
|---|---|---|---|---|
| GET | `/` | admin+sup | query: `product_variant_id` | Master recipe rows for a variant. |
| POST | `/` | **admin** | `createRecipeSchema` | Master recipe row. |
| PATCH | `/:id` | **admin** | `updateRecipeSchema` | |
| DELETE | `/:id` | **admin** | — | 204. Soft delete (`deletedAt`). |
| POST | `/simulate` | admin+sup | `simulateDeductionSchema` | Runs the layered deduction algorithm without writing inventory movements. A supervisor passing a `branch_id` outside their `branch_ids` gets `403 BRANCH_ACCESS_DENIED` (checked inline, since `branch_id` here is optional and only sometimes present). |
| GET | `/:variantId/overrides` | admin+sup, `branchGuard` | query: `branch_id` (required) | CR-001 branch override rows. |
| POST | `/:variantId/overrides` | **sup**, `branchGuard` | `createRecipeOverrideSchema` | No approval workflow — audit-logged with mandatory `reason`. |
| PATCH | `/overrides/:overrideId` | **sup**, `branchGuard` | `updateRecipeOverrideSchema`; query: `branch_id` (required) | |
| DELETE | `/overrides/:overrideId` | **sup**, `branchGuard` | query: `branch_id` (required) | 204. Soft delete (`deletedAt`) — see `docs/architecture/database-schema.md`'s index-state table. |

## inventory — `inventoryRouter` mounted at `/api/inventory`, `inventoryBranchRouter` mounted at `/api/branches`

| Method | Path | Access | Request schema | Notes |
|---|---|---|---|---|
| GET | `/api/inventory/ingredients` | admin+sup, `branchGuard` | query: `branch_id?` | |
| GET | `/api/inventory/ingredients/:id` | admin+sup | — | `branchGuard` can't run here (only an ingredient id is in the URL) — branch access is checked inline once the ingredient is fetched. |
| POST | `/api/inventory/ingredients` | **admin** | `createIngredientSchema` | |
| PATCH | `/api/inventory/ingredients/:id` | **admin** | `updateIngredientSchema` | |
| DELETE | `/api/inventory/ingredients/:id` | **admin** | — | 204. Soft delete. |
| POST | `/api/inventory/ingredients/:id/stock-in` | admin+sup | `stockInSchema` | Writes an `InventoryMovement` row. |
| POST | `/api/inventory/ingredients/:id/adjust` | admin+sup | `adjustIngredientSchema` | |
| POST | `/api/inventory/ingredients/:id/waste` | admin+sup | `wasteIngredientSchema` | |
| GET | `/api/branches/:branchId/inventory` | admin+sup, `branchGuard` | — | Full branch stock snapshot. |
| GET | `/api/branches/:branchId/inventory/alerts` | admin+sup, `branchGuard` | — | Low/critical stock alerts. |
| GET | `/api/branches/:branchId/inventory/movements` | admin+sup, `branchGuard` | query: `ingredient_id?`, `movement_type?`, `from_date?`, `to_date?`, `page`, `limit` | |
| POST | `/api/branches/:branchId/inventory/count` | admin+sup, `branchGuard` | `physicalCountSubmissionSchema` | `400 BRANCH_ID_MISMATCH` if the body's `branch_id` disagrees with the URL. |
| POST | `/api/branches/:branchId/inventory/transfer` | admin+sup, `branchGuard` | `transferIngredientSchema` | Branch-to-branch stock transfer, one atomic transaction. |

## product-requests — mounted at `/api/product-requests` (CR-001)

| Method | Path | Access | Request schema | Notes |
|---|---|---|---|---|
| GET | `/` | admin+sup | query: `status?`, `branch_id?`, `requested_by?`, `page`, `limit` | |
| POST | `/` | **sup** | `createProductRequestSchema` | Proposes a brand-new catalog product; nothing is committed until reviewed. |
| GET | `/:id` | admin+sup | — | |
| POST | `/:id/review` | **admin** | `reviewProductRequestSchema` | Approval creates the real `Product`/`ProductVariant`/`Recipe` rows from the request's JSON snapshot and sets `createdProductId`. |

## price-overrides — mounted at `/api/price-overrides` (CR-001)

| Method | Path | Access | Request schema | Notes |
|---|---|---|---|---|
| GET | `/` | admin+sup | query: `status?`, `branch_id?`, `page`, `limit` | |
| POST | `/` | **sup** | `createPriceOverrideSchema` | At most one pending request per `(branch_id, product_variant_id)` — enforced by a partial unique index. |
| POST | `/:id/review` | **admin** | `reviewPriceOverrideSchema` | |

## transactions — mounted at `/api/transactions`

| Method | Path | Access | Request schema | Notes |
|---|---|---|---|---|
| POST | `/` | **all**, `branchGuard`, `shiftGuard` | `createTransactionSchema` | The one route requiring an active shift (staff only — supervisor/super_admin are exempt per `shift-guard.ts`). |
| GET | `/` | **all**, `branchGuard` | `transactionListQuerySchema` (`branch_id`, `shift_id?`, `status?`, `payment_method?`, `date_from?`, `date_to?`, `page`, `limit`) | |
| GET | `/:transactionId` | **all** | — | Inline branch check (only a transaction id is in the URL). |
| POST | `/:transactionId/void` | admin+sup | `voidTransactionRequestSchema` (`void_reason`) | Inline branch check. |
| POST | `/:transactionId/refund` | admin+sup | `refundTransactionRequestSchema` (`refund_reason`) | Inline branch check. |
| POST | `/:transactionId/receipt-printed` | **all** | — | Marks the receipt as printed; inline branch check. |

## employees — mounted at `/api/employees`

| Method | Path | Access | Request schema | Notes |
|---|---|---|---|---|
| GET | `/` | admin+sup | query: `role?`, `employment_type?`, `is_active?`, `branch_id?`, `search?`, `page`, `limit` | |
| GET | `/:employeeId` | admin+sup | — | |
| GET | `/:employeeId/payroll` | **admin** | — | Decrypts government-ID fields (AES-256-GCM); read itself is audit-logged. |
| GET | `/:employeeId/activity` | admin+sup | — | |
| POST | `/` | **admin** | `createEmployeeSchema` | |
| PATCH | `/:employeeId` | **admin** | `updateEmployeeSchema` | |
| POST | `/:employeeId/deactivate` | **admin** | `deactivateEmployeeSchema` | Handles deactivation-while-shift-active per Phase 5. |
| POST | `/:employeeId/reactivate` | **admin** | — | |
| POST | `/:employeeId/reset-password` | **admin** | `resetEmployeePasswordSchema` (`new_password`) | |

## cash — mounted at `/api/cash` (shift and cash management)

| Method | Path | Access | Request schema | Notes |
|---|---|---|---|---|
| POST | `/open` | admin+sup, `branchGuard` | `openShiftSchema` | Opening denomination count. |
| GET | `/current` | **all**, `branchGuard` | query: `branch_id` | |
| GET | `/` | admin+sup, `branchGuard` | query: `branch_id?`, `status?`, `page`, `limit` | |
| GET | `/:shiftId` | **all** | — | Inline branch check. |
| GET | `/:shiftId/summary` | admin+sup | — | Inline branch check. |
| POST | `/:shiftId/close` | admin+sup | `closeShiftSchema` | Closing denomination count + variance calc. |
| POST | `/:shiftId/approve-variance` | **admin** | `approveVarianceSchema` | |
| POST | `/:shiftId/void` | **admin** | `voidShiftSchema` | |

## Also implemented (endpoint tables not yet written up)

These modules have real routes now, not the Phase-0 scaffold this doc previously described — see the router file for the current contract until a full table is added here:

| Module | Mounted at | Router |
|---|---|---|
| `attendance` | `/api/attendance` | `apps/api/src/modules/attendance/attendance.router.ts` |
| `reports` | `/api/reports` | `apps/api/src/modules/reports/reports.router.ts` |
| `fraud` | `/api/fraud` | `apps/api/src/modules/fraud/fraud.router.ts` |
| `notifications` | `/api/notifications` | `apps/api/src/modules/notifications/notifications.router.ts` |

## Not yet implemented

The following modules exist as `apps/api/src/modules/<name>/` scaffolds (router, service, types files present, service imported but unused via `void <name>Service;`) but have zero real routes — each is a single `TODO(Phase 1+)` comment. They're still mounted in `app.ts` at their eventual prefix so the prefix reservation is visible, but every path under them currently 404s:

| Module | Mounted at | Corresponds to |
|---|---|---|
| `discounts` | `/api/discounts` | Discount-type reference data supporting the Phase 10 POS discount flow (VAT/PWD/senior-citizen calc itself already lives in `transactions`) |
| `receipts` | `/api/receipts` | Receipt formatting/reprint support for the Phase 10 POS transaction flow |
| `audit` | `/api/audit` | Audit-log query/export UI backing — writes already happen via `recordAuditLog` from every other module; this module is the read/export API |
