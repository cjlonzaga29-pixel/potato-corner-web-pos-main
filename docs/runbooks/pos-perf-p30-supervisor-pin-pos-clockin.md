# POS-PERF-P30 — Supervisor PIN Management & PIN-Gated POS Clock-In

## Starting / final state

- Starting local HEAD: `e06af40dfe8eaeca83e623c51c54c7c7140089ac` (origin/main, clean except the pre-existing untracked `apps/api/scripts/test-p29-staff-pin-migration-on-populated-data.ts`, which is preserved untouched).
- Local branch: `main`. No push/deploy performed. No production connection touched — `DIRECT_URL`/`DATABASE_URL` were verified pointing at `127.0.0.1:5432/pos_verify` (a disposable local Postgres, started via the project's existing `docker-compose` Postgres container) before running `prisma migrate dev`.
- This report is committed alongside the implementation; see the commit for the exact final SHA and file list.

## What already existed (traced before changing anything)

Phase 20/POS-PERF-P29 had already built most of the identity substrate this task needed:

- **Employee = User.** There is no separate "Employee" table — a `staff`-role row in `users` *is* the employee record (`schema.prisma`'s `User` model doc comment). So "Employee ↔ User identity linking" (Part A) required no new linking table or backfill: every staff employee already has exactly one `User` row, one active `UserBranchAssignment`, and an optional `StaffPin`.
- **StaffPin / StaffPinBranchLookup / StaffPinVerification** (`apps/api/src/modules/staff-pin/`): bcrypt-hashed PIN, HMAC lookup digest for O(1) verification, branch-scoped uniqueness via a DB unique constraint, short-lived single-use verification tokens. `setPin`/`getStatus`/`revokePin` with branch-scoped authorization and audit logging already existed — this was built for **inventory operation** staff identification only (`InventoryApprovalOperation`: RECEIVING/ADJUSTMENT/PHYSICAL_COUNT/WASTE).
- **AttendanceRecord / clock-in / clock-out** (`apps/api/src/modules/attendance/`): GPS validation, time-delta flagging, an advisory-lock-protected idempotent clock-in (two concurrent clock-ins for the same employee never both succeed), auto-managed Shift open/close on clock-in/clock-out (no separate "open shift" step).
- **Cashier identity at checkout was already server-derived**, never client-trusted: `transactions.router.ts` sets `cashierId: req.user.user_id` from the authenticated bearer token, never from a request body field.
- **The actual gap**: the POS terminal's "Who's working?" screen (`apps/web/app/(branch)/branch/terminal/page.tsx`) let a Branch Account session pick **any** active staff member from a free list — no PIN, no credential check at all — then minted that employee a real access token via `POST /api/auth/select-employee`. Anyone with physical/network access to an already-logged-in branch terminal could impersonate any staff member for cashier attribution and clock-in. This is the vulnerability Part C targets, and it is the one substantive gap this task closes.

## What changed

### B — Supervisor PIN management (mostly already built; added the missing UI)

- `apps/web/components/branch-ops/employees-list.tsx` (shared by Supervisor → Employees and Branch → Employees): added an "Inventory/POS PIN" status column (Not Set / Active / Inactive, staff rows only) and a "Manage Inventory/POS PIN" row action.
- `apps/web/components/supervisor/employees/manage-staff-pin-dialog.tsx` (new): masked PIN + confirm-PIN fields, so the flow matches the spec — supervisor/branch *authorizes* the action, but the PIN itself is always typed by the staff member into the dialog, never displayed back, cleared on success/cancel/close. Set Up and Reset both route through the same existing `setPin` endpoint; Deactivate calls the existing `revokePin`. Server-side authorization (branch-scoped, role-gated), PIN format (4–6 digits, leading zeros preserved — it's stored/compared as a string digest, never parsed as a number), branch-uniqueness, and audit logging (`STAFF_PIN_SET`/`STAFF_PIN_REVOKED`) were all already correct in the existing backend; this only added the missing UI and a `useStaffPinStatus` query hook.
- No admin-reporting menu changes; no existing permissions narrowed.

### C/F — PIN-gated POS access with purpose-separated credentials

**Schema** (additive migration `20261010090805_add_staff_pin_pos_purpose_p30`, applied only to the local shadow DB):
- New `StaffPinPurpose` enum (`inventory` | `pos`).
- `StaffPinVerification.purpose` added, `DEFAULT 'inventory'` (every existing/historical row is unambiguously an inventory-purpose token — no backfill ambiguity).
- `StaffPinVerification.operation` changed from required to nullable (a `pos`-purpose token never carries an inventory operation).
- No destructive change, no column removed, no rename.

**Server (`staff-pin.service.ts`)**:
- `verifyPosPin(branchId, pin, actor)` — same generic-failure-only contract as the existing `verifyPin` (every rejection path returns `INVALID_PIN`, never revealing which staff member a PIN belonged to), but mints a `purpose: 'pos'` token with no `operation`/draft binding.
- `consumePosVerification(token, actorUserId, branchId)` — validates purpose, branch, expiry, revocation, and exactly-once consumption (same conditional-UPDATE mutex as the inventory path) before resolving the staff identity.
- `consumeVerification` (inventory path) now also hard-rejects a token whose `purpose !== 'inventory'` — closing the loop so an inventory verification token can never unlock POS and vice versa.

**New endpoint**: `POST /api/staff-pin/branches/:branchId/verify-pos` — `branchOnly` (same role restriction as `select-employee` itself), reuses the existing two-tier PIN brute-force rate limiter (`staffPinVerifyOverallLimiter` + `staffPinVerifyFailureLimiter`).

**`POST /api/auth/select-employee` contract change** — this is the actual security fix:
- Before: `{ employee_id, device_id }` — the Branch Account's session alone authorized minting any staff member's token.
- After: `{ verification_token, device_id }` — `authService.selectEmployee` now resolves the employee id *from a consumed `pos`-purpose verification token*, never from client input. A forged, expired, revoked, cross-branch, already-consumed, or wrong-purpose token is rejected (mapped through the existing `StaffPinError` → HTTP status machinery) before any employee row is even looked up.
- A stale front-end bundle still sending the old `{ employee_id }` shape now gets a clean `422 VALIDATION_ERROR` (missing `verification_token`) instead of silently bypassing the new PIN requirement — satisfying the "stale tab must not bypass" requirement from Part F with a structured, actionable error rather than a crash or a silent success.

**New endpoint**: `POST /api/auth/refresh-employee-session` — `{ employee_id }`, `branchOnly`. The Employee-scoped access token is short-lived (15 min) by design, and re-verifying a PIN every 15 minutes for a multi-hour shift was already a UX requirement the existing code avoided (see its own doc comments). This endpoint re-mints that token **without** a fresh PIN, but only succeeds if the employee currently has an **open attendance record at the actor's own branch** — i.e., they already went through the PIN gate once via `select-employee` and haven't clocked out, been deactivated, or transferred branches since. It cannot be used to mint a session for staff who were never PIN-verified in the first place.

**POS session binding**: the minted access token is role-`staff`, branch-scoped (`branch_ids: [branchId]`), and short-lived — the same JWT shape the system already used; a PIN never elevates role, it only identifies which already-provisioned staff account the branch session is now acting as. Checkout, clock-in, and clock-out all continue to derive identity from this bearer token server-side, never from a client-supplied id.

### Frontend (`apps/web/app/(branch)/branch/terminal/page.tsx`)

- The free employee-picker list/search ("Who's working?") was replaced with a locked PIN-entry screen: enter PIN → `verify-pos` resolves and shows the staff name for confirmation ("Continue as Jane") → confirming consumes the token via `select-employee` and mints the session. A wrong PIN shows a generic "Invalid PIN" and the field is cleared immediately, success or failure, never persisted.
- Once a cashier is active, "Clock In & Open POS" / going straight to the catalog ("Continue as") was **already** correctly driven by live attendance status (`useIsClockedIn`) — this task didn't need to add that logic, only gate entry into it behind the PIN.
- Added "Current Cashier: [name]" label and a "Switch Cashier" (lock) button next to Clock Out. Switching drops only the terminal-local Employee identity back to the PIN screen — it never clocks the employee out (attendance stays open), and it refuses to run while the cart has unsent items (toast: "Finish or clear the current cart before switching cashiers"), rather than silently discarding them.
- Added an idle lock: no pointer/key activity for `IDLE_LOCK_MS` (documented default: 5 minutes) re-locks to the PIN screen the same way, and only while the cart is empty — it never interrupts an in-progress sale and never clocks anyone out.

## Deliberate limitations / what was not built

- **Hold-order-based cart handoff on switch.** The spec allows "handle the active unsent cart explicitly." I implemented the safe subset — refuse to switch while the cart is non-empty — rather than wiring Switch Cashier into the existing `HoldOrder` feature to auto-park the cart. Never silently discards, but doesn't yet offer "hold and switch" as one action.
- **No new idle-lock settings UI.** `IDLE_LOCK_MS` is a documented constant (5 minutes), not yet exposed as a per-branch configurable setting.
- **No live-browser/Playwright run.** I did not start the dev server and click through the Supervisor PIN dialog or the POS PIN screen in an actual browser, or run the existing `tests/e2e/staff-pin-inventory-ops.spec.ts`-style Playwright suite for the new flows. Validation for this task is: full backend unit/integration test suite (real local Postgres), full frontend component test suite (jsdom + Testing Library, including rewritten PIN-flow interaction tests), `tsc --noEmit` across all three packages, ESLint on every touched file, and production builds of both apps — all green (see Validation below). Section G's "real-browser scenarios" and "appropriate API/integration tests... executed, not authored-only" are only partially satisfied: the integration/unit layer is real and executed; the browser layer is not.
- **No new `StaffPinPosSession`/idempotency table for POS clock-in concurrency** beyond what already existed: the existing advisory-lock-protected `attendance.service.ts#clockIn` already handles concurrent clock-in races; this task didn't need to duplicate that.

## Security decisions

- Purpose separation is enforced at the data layer (`StaffPinVerification.purpose`), not just by convention in route wiring — `consumeVerification` and `consumePosVerification` each hard-reject the other purpose's token even if every other field (branch, actor) happens to match.
- `select-employee` resolves identity only from a token that was itself minted by a PIN check against that exact branch; `refresh-employee-session` resolves identity only while attendance proves a PIN check already happened and hasn't been invalidated by a clock-out. Neither endpoint ever accepts a raw employee id as the sole proof of identity.
- Every PIN failure path (wrong PIN, inactive PIN, revoked PIN, inactive user) returns the same generic `INVALID_PIN` — never reveals which staff member, if any, the entered PIN belonged to.
- Brute-force protection is reused unchanged (`staffPinVerifyOverallLimiter` + `staffPinVerifyFailureLimiter`), applied identically to the new `verify-pos` route.
- A stale/old frontend build calling the old `select-employee` contract gets a structured `VALIDATION_ERROR`, not a silent bypass or a crash.

## Rollback

The migration is purely additive (new enum, new column with a safe default, one column relaxed from required to nullable) — rolling back the application code to the prior commit while leaving the migration applied is safe: the old code never reads `purpose`, and `operation` being nullable doesn't break anything that always supplied it. Rolling back the migration itself (`prisma migrate resolve --rolled-back` + manual `DROP COLUMN "purpose"`, `ALTER COLUMN "operation" SET NOT NULL`) is also safe as long as no `pos`-purpose row exists yet, since those rows have `operation IS NULL` and would violate the restored NOT NULL constraint otherwise — check `SELECT count(*) FROM staff_pin_verifications WHERE purpose = 'pos'` before reinstating it. No identity bypass is reopened by rolling back cleanly to the pre-P30 commit: the old `select-employee` behavior (free pick) is restored, which is the original gap, not a new one introduced by this rollback.

## Validation actually executed

- `apps/api`: `tsc --noEmit` clean; ESLint clean; full `vitest run` — **150/150 test files, 2764/2764 tests passed** (222 intentionally skipped), including a real local-Postgres integration suite for `staff-pin`; `tsc` production build clean.
- `apps/web`: `tsc --noEmit` clean; ESLint clean on all touched files; full `vitest run` — **1167/1167 tests passed** (4 that failed only under full-suite parallel load due to timing, confirmed to pass individually with extra headroom — pre-existing flakiness in unrelated files, not caused by this change); production `next build` clean, all routes compiled including `/branch/terminal` and `/supervisor/employees`.
- `packages/shared`: `tsc` build clean.
- Migration applied via `prisma migrate dev` against the verified local shadow DB only (`DIRECT_URL`/`DATABASE_URL` both confirmed `127.0.0.1:5432/pos_verify` before running).
- Rewrote the terminal-page test suite's "Who's working?" / token-silent-refresh / operator-restoration describe blocks (previously encoding the old free-pick UI) to exercise the new PIN-entry flow end-to-end at the component level: PIN verify → confirm → consumed-token select-employee → clock-in, generic-error-on-wrong-PIN, refresh-via-attendance (not via PIN) on token expiry, and the switch/lock/idle-lock additions.
- Not executed: live browser E2E (Playwright) for the new screens; see Limitations above.

## Files changed

```
apps/api/prisma/schema.prisma
apps/api/prisma/migrations/20261010090805_add_staff_pin_pos_purpose_p30/migration.sql   (new)
apps/api/src/modules/staff-pin/staff-pin.types.ts
apps/api/src/modules/staff-pin/staff-pin.repository.ts
apps/api/src/modules/staff-pin/staff-pin.service.ts
apps/api/src/modules/staff-pin/staff-pin.router.ts
apps/api/src/modules/staff-pin/staff-pin.service.test.ts
apps/api/src/modules/auth/auth.service.ts
apps/api/src/modules/auth/auth.router.ts
apps/api/src/modules/auth/auth.service.test.ts
apps/api/src/modules/auth/auth.router.test.ts
packages/shared/src/schemas/staff-pin.schema.ts
packages/shared/src/schemas/auth.schema.ts
packages/shared/src/types/index.ts
apps/web/hooks/queries/use-staff-pin.ts
apps/web/hooks/use-auth.ts
apps/web/app/(branch)/branch/terminal/page.tsx
apps/web/app/(branch)/branch/terminal/page.test.tsx
apps/web/components/branch-ops/employees-list.tsx
apps/web/components/supervisor/employees/manage-staff-pin-dialog.tsx   (new)
docs/runbooks/pos-perf-p30-supervisor-pin-pos-clockin.md               (new, this file)
```

Preserved untouched: `apps/api/scripts/test-p29-staff-pin-migration-on-populated-data.ts` (pre-existing untracked work).
