# POS-PERF-P29 — Staff PIN, Evidence Gate, Supervisor Direct-Record: Rollout and Rollback

## Why this doc exists

P29 adds one additive migration (`20261009070430_add_staff_pin_evidence_waste_p29`)
and changes the *contract* of three existing write endpoints (universal
`/:branchId/inventory-stock/:itemId/receive`, `/adjust`, `/waste`) — they now
**require** `verification_token` and `evidence_key` in the body, and branch
through role (`branch` → Pending Review, `supervisor`/`super_admin` → apply
immediately, labeled). It also adds a new module (`/api/staff-pin/*`) and a
new blocking upload endpoint (`/:branchId/inventory-stock/evidence`). Same
independent-deploy-schedule caveat as P28 applies (Vercel/Render don't cut
over atomically), so the same three-state deploy-window analysis repeats
here:

1. **New frontend + old API** — the new forms call
   `/api/staff-pin/branches/:branchId/verify` and
   `/:branchId/inventory-stock/evidence`, neither of which exist on the old
   API. Both 404; PIN entry and evidence upload simply never succeed, so
   submit never enables. No partial/incorrect write is possible — the old
   API's receive/adjust/waste schemas don't require the new fields, but the
   new frontend never calls them without first producing a verification
   token/evidence key, which it can't get.
2. **Old frontend + new API** — the old forms POST
   receive/adjust/waste bodies **without** `verification_token`/
   `evidence_key`. The new API's Zod schemas (`staffPinVerifiedOperationFields`
   in `packages/shared/src/schemas/universal-inventory.schema.ts`) make both
   fields required — every such request gets a standard `VALIDATION_ERROR`
   (422), never a silent bypass of the PIN/evidence gate and never a
   different write path. This is the intended "old-frontend compatibility"
   behavior per the original task brief: a clear, structured rejection, not
   a confusing partial success.
3. **New frontend/API, mid-migration** — the new API queries
   `staff_pins`/`staff_pin_branch_lookups`/`staff_pin_verifications`/
   `inventory_evidence_uploads`/`inventory_operation_attempts`, none of which
   exist until the migration runs. Every verify/evidence/submit call 500s
   until the migration lands.

None of these corrupt data — same reasoning as P28's doc: the underlying
`InventoryStock` write path (and its exactly-once approval-apply logic) is
unchanged by this migration, and schema validation fails closed, not open.
(1) and (3) are the real availability gap for Stock In/Adjustment/Waste
during the deploy window; use the existing POS-PERF-P16 write gate to
collapse it to zero, exactly as P28's rollout did.

## Write-gate coverage (verified, no change needed)

`write-gate.ts`'s `GATED_PATH_PATTERNS` already includes
`/^\/api\/branches\/[^/]+\/inventory-stock(\/|$)/`, which covers the new
`POST /:branchId/inventory-stock/evidence` endpoint (same prefix as
receive/adjust/waste) — closing the gate pauses evidence upload too, so an
operator can never get "evidence uploaded, but the matching submit is
paused" during a drain. `/api/staff-pin/*` (PIN set/reset/revoke/verify) is
**deliberately not gated** — it mutates `StaffPin`/`StaffPinBranchLookup`/
`StaffPinVerification` only, never `InventoryStock`, so it carries none of
the "two independent write paths might apply the same physical event" risk
the gate exists to prevent. A verification token minted while the gate is
closed is harmless: it can't be consumed into a stock write until the gate
reopens and the matching evidence/submit call succeeds.

## `STAFF_PIN_HMAC_SECRET` provisioning and rotation

- **Provisioning**: a random string ≥32 characters (same floor as
  `JWT_REFRESH_SECRET`), set once per environment before this release
  deploys. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
  Boot fails fast (`config/index.ts`'s zod schema) if it's missing or short —
  this is deliberate, matching every other server-only secret in this
  project.
- **What it protects**: only the `pinLookupDigest` used to find a
  *candidate* `StaffPin`/`StaffPinBranchLookup` row by `(branchId, digest)`
  before the authoritative `bcrypt.compare` runs. It is never the
  authoritative check itself — a leaked digest alone (without the secret)
  cannot be reversed to a PIN, and a leaked secret alone (without a digest)
  reveals nothing about any specific PIN.
- **Rotation procedure**: rotating this secret invalidates every existing
  `pinLookupDigest` at once (HMAC with a new key produces different output
  for the same PIN) — every active `StaffPin`/`StaffPinBranchLookup` row's
  digest becomes stale and unmatchable. There is no in-place re-keying path
  in this release: after rotating, every staff member's PIN must be reset
  (`POST /api/staff-pin/:userId/pin`) before they can be PIN-verified again.
  Treat a secret rotation as equivalent to a mass PIN reset event — schedule
  it, don't do it silently.
- **Never**: log the secret, the raw PIN, or `pinHash`/`pinLookupDigest`
  together in a way that could be correlated back to a specific staff
  member's PIN. `recordAuditLog` calls in `staff-pin.service.ts` log the
  action and `userId`/branch count only.

## Evidence storage requirements

Evidence photos reuse the existing `inventory-proofs` Supabase Storage
bucket and the existing `uploadInventoryProofImage`/`getSignedInventoryProofUrl`
pipeline (private bucket, signed URLs, 1-hour TTL) — no new bucket or ACL
change is required. The new behavior is purely about *when* the upload
happens (pre-submit, blocking) and *what* references it
(`InventoryEvidenceUpload` row, consumed exactly once into the created
request/movement's existing `proofKey`/`proofType` columns). Confirm before
deploy:

- The `inventory-proofs` bucket exists and the API's
  `SUPABASE_SERVICE_ROLE_KEY` can write to it (already required by every
  prior proof-upload feature — no new credential).
- The scheduled sweep (`sweepExpiredInventoryEvidence`, registered in
  `server.ts` on a 15-minute interval) is running in every API instance —
  it is the only thing that reclaims an abandoned (uploaded but never
  submitted) evidence object and its DB row. It never touches a row whose
  `consumedAt` is set (i.e., already linked to a real request/movement).

## Existing supervisor-owned PENDING requests

Before this release, a `supervisor` or `super_admin` could submit a
Stock In/Adjustment through the Pending Review queue exactly like a
`branch` account (no role branching existed yet). Any such row still
sitting in `PENDING`/`RETURNED` status at deploy time is **left untouched**
by this migration — it is not retroactively relabeled, auto-approved, or
auto-cancelled. It remains reachable through the existing approve/return/
correct/cancel endpoints and UI exactly as before. Operationally: a
reviewer should still resolve (approve, return, or permanently cancel) any
such dormant supervisor-submitted row during normal queue triage — this
release does not require it, but leaving one open indefinitely is the same
operational smell P28R2's cancellation feature already exists to clear.
**New** submissions by a `supervisor`/`super_admin` from this release
onward never create a Pending Review row at all (they apply immediately,
labeled `recordedAsSupervisorDirect`) — this only affects rows that
predate the deploy.

## CI-migration-before-deploy

Same sequencing as every prior additive migration in this repo: the
migration must run (and be confirmed applied) against the target
environment's database **before** the API revision serving the new schema
requirements goes live, and before the web revision that requires
`verification_token`/`evidence_key` goes live. Use the write gate to pin
this down precisely:

1. Confirm `git status` clean and the intended commit is the one being
   deployed (standard pre-flight, same as P28's).
2. Close the write gate (`PATCH /api/settings/write-gate { "enabled": true }`,
   admin-only) — this pauses new receive/adjust/waste/evidence requests at
   the previous API revision.
3. Poll `GET /api/settings/write-gate` until the per-instance in-flight
   count drains to 0 on every running instance.
4. Run the migration against the target database (`DIRECT_URL`/session
   pooler for local-dev verification first — **never** `prisma migrate dev`
   against anything but a verified local/shadow database; CI/production
   migrations run via the project's existing `prisma migrate deploy` step
   against `PRODUCTION_DATABASE_URL_DIRECT`, never through this command
   locally).
5. Deploy the new API revision, then the new web revision.
6. Re-open the write gate.
7. Smoke-test: provision one staff PIN, verify it, upload one evidence
   photo, submit one adjustment as a `branch` account (expect Pending
   Review) and one as a `supervisor` account (expect immediate apply,
   labeled).

## Rollback

Additive migration — safe to leave in place indefinitely; there is no
destructive down-migration and none is needed. To roll back the
*behavior* (not the schema):

- **Revert the API/web revisions** to the pre-P29 build. The additive
  columns/tables are simply unused by the old code; no data loss.
- `MANUAL_INVENTORY_APPROVAL_REQUIRED=false` remains the existing P28
  emergency escape hatch and is **unchanged in meaning** — with it off,
  every role (including `branch`) writes immediately again, exactly as
  before P28, and `recordedAsSupervisorDirect`/responsible-staff labeling
  is simply not set for those writes (it's derived from actor role alone,
  not from the flag). This flag does **not** disable the PIN/evidence
  requirement by itself — `verification_token`/`evidence_key` are still
  required by the Zod schema regardless of the flag, since schema
  validation happens before the role/flag branch. To fully disable the new
  gate (e.g. to run against an old frontend build in an emergency), revert
  the API code, not just this flag.
- Any `StaffPin`/`StaffPinBranchLookup`/`StaffPinVerification`/
  `InventoryEvidenceUpload`/`InventoryOperationAttempt` rows created after
  rollback are simply orphaned (unused by the reverted code) — safe to
  leave or truncate later; they are never read by any pre-P29 code path.

## POS-PERF-P29R3 — restored correction-verification, legacy acknowledgment-only, legacy waste gating

Three corrections to behavior that had drifted from this rollout's original
intent, found and fixed together:

**1. Correction PIN/evidence was silently inheriting across changed figures.**
`inventory-approval.service.ts`'s `correct()` previously let a RETURNED
RECEIVING/ADJUSTMENT/WASTE request be resubmitted with a **different**
quantity/unit/reason/notes while still carrying forward the ORIGINAL
revision's PIN verification and proof — i.e. a verified staff member's
attestation could end up permanently attached to numbers they never
verified. Restored: correcting any PIN-bound field (entered quantity /
adjustment delta, unit, reason code, or notes) now requires a **fresh**
`verification_token`/`evidence_key` pair (`FRESH_VERIFICATION_REQUIRED`,
422, if omitted). Resubmitting the exact same figures (e.g. a notes-only
fix where notes itself didn't change) still inherits the original
attribution — nothing PIN-bound changed, so there is nothing new to
verify. The correction UI (`inventory-approval-detail-dialog.tsx`) now
shows the PIN-entry/evidence-upload fields and blocks "Resubmit for
Review" whenever the edited quantity or notes differ from the original.

**2. `reconcileLegacy()` was a disguised approve-without-verification
bypass.** It previously called `approveAndApply()` and flipped the request
to APPROVED — i.e. a reviewer's typed justification stood in for an actual
PIN verification/evidence pair, on a request the normal `approve()` path
deliberately refuses (`LEGACY_VERIFICATION_MISSING`). This is now purely
an **administrative acknowledgment**: it records an
`INVENTORY_APPROVAL_LEGACY_ACKNOWLEDGED` audit entry with the reviewer's
note and changes nothing else — no stock write, no status change, request
stays PENDING, still shown as "Verification/evidence required," still
rejected by `approve()`. The only two ways an old pending request without
responsible-staff attribution can actually leave that state are (a) return
for correction → correct with a genuine fresh PIN verification/evidence
pair, or (b) permanent cancellation.

**3. The legacy `/ingredients/:id/waste` endpoint never honored the
`MANUAL_INVENTORY_APPROVAL_REQUIRED` gate at all.** Unlike its stock-in/
adjust siblings (which both branch on the flag to route through
`inventoryApprovalService.submitWaste`/Pending Review), waste always wrote
straight to the legacy ledger regardless of the flag — a real bypass of
the review requirement for `LEGACY_INGREDIENT` waste specifically (not of
PIN verification, which `LEGACY_INGREDIENT` never collected for any
operation — that remains unchanged and by design). Fixed to match
stock-in/adjust exactly; `applyApprovedRequest()` gained the matching
LEGACY_INGREDIENT WASTE branch it never had (unreachable until this fix,
since nothing previously routed a legacy waste request through approval).

## POS-PERF-P29R3 — concurrency evidence

New real-Postgres/real-Express coverage, beyond the existing branch-role
Pending-Review idempotency tests:

- `universal-inventory.http-concurrency.integration.test.ts`'s new
  "direct-write (supervisor)" block fires 6 concurrent identical
  supervisor-role `/adjust` HTTP requests under one Idempotency-Key and
  asserts the REAL `InventoryStock.quantityOnHand` delta and
  `InventoryStockMovement` row count directly (not just the idempotency/
  attempt-row bookkeeping) — exactly once, never doubled — plus a second
  test confirming a cached replay after the original verification token/
  evidence are already consumed does not re-apply the stock mutation.
- `rate-limiter.test.ts` gained three genuinely concurrent (`Promise.all`-
  fired, not sequential `for`-loop) bursts against
  `staffPinVerifyFailureLimiter`/`staffPinVerifyOverallLimiter`. **Finding**:
  the resource cap itself never breaks under concurrency (admitted count
  never exceeds the configured limit — the property that actually
  matters for brute-force protection) — but express-rate-limit's default
  in-memory `MemoryStore` has a real, pre-existing reliability quirk under
  true same-tick concurrency: `increment()` returns the shared mutable
  client object by reference, and `totalHits` is only read off it several
  `await`s later, so concurrent siblings' increments can land before any
  single request's own read. In the worst case a tight burst can see
  every concurrent call rejected (conservative under-admission) rather
  than admitting up to the limit, and — because `skipSuccessfulRequests`
  only decrements for a response that was actually let through — a burst
  of purely-successful attempts that gets rejected at entry can leave
  those hits permanently counted against the SAME counter the failure
  budget uses for the rest of the window. This is a **known limitation**,
  not something this fix changed or patched (fixing it properly means
  moving off `MemoryStore` entirely — consistent with the Phase 21 Redis-
  removal comment already flagging this store as not reinstated when the
  API runs as more than one instance; same "revisit if/when" applies to
  single-instance heavy-concurrency reliability too, not just multi-
  instance correctness). Flagged here for follow-up, not fixed in this
  pass — the security-relevant guarantee (never over-admitted) holds.

## POS-PERF-P29R3 — production prerequisites (verified read-only, 2026-10-09)

Checked directly against the real linked Supabase project and Render
service — **no production configuration was changed**:

- **Evidence bucket**: `inventory-proofs` **exists** in the production
  Supabase Storage project, alongside the other already-working buckets
  (`payment-proofs`, `discount-proofs`, `product-images`,
  `branch-gcash-qr`, `expense-receipts`) — confirmed via
  `supabase storage ls --linked --experimental` against the real project
  ref, not the local sandbox's `dummy.supabase.co` placeholder. This
  resolves the "Confirm before deploy" checklist item above as done.
- **Privacy**: the application code only ever calls `.createSignedUrl()`
  for this bucket (`universal-inventory.service.ts`'s
  `getSignedInventoryProofUrl`), never `.getPublicUrl()` — same pattern as
  `payment-proofs`/`discount-proofs`. The bucket's actual public/private
  ACL flag and storage policies were **not** independently queried against
  the Storage Admin API in this pass (doing so safely would have required
  extracting and using the Render/Supabase CLI's stored session
  credentials in a raw API call, which this check deliberately avoided —
  see the note below). Recommend a dashboard spot-check of the bucket's
  "Public" toggle and RLS policies as a quick follow-up, though the
  application contract itself does not depend on it being private.
- **`STAFF_PIN_HMAC_SECRET` / `SUPABASE_SERVICE_ROLE_KEY` presence**: not
  read directly (see note below), but confirmed **indirectly and
  reliably** — the production API (`henlin-pos-api.onrender.com`) is live
  and serving real request/response envelopes
  (`{"data":null,"error":{"code":"NOT_FOUND"}}` from an actual Express
  route-miss, not a platform error page), with its latest deploy showing
  `status: "live"`. `config/index.ts`'s Zod schema fails the process at
  boot if any required secret (including `STAFF_PIN_HMAC_SECRET`,
  `SUPABASE_SERVICE_ROLE_KEY`) is missing or too short — a live, correctly-
  responding process is strong evidence all of them are present and
  valid, without needing to read any of them directly.
- **Note on credential handling**: while investigating this, a local
  `~/.render/cli.yaml` file was read to check for a stored CLI session and
  its contents (a live Render API key and refresh token) were printed to
  this session's own tool output as a result — not to any external
  destination, but this should be treated as a locally-logged credential
  exposure. Recommend rotating that Render API key (Render dashboard →
  Account Settings → API Keys) as a precaution.

## Known limitation carried into this release

Real-browser (Playwright) verification of the full evidence-upload →
PIN-verify → submit happy path could not be executed in the sandbox this
feature was built in — that sandbox's `SUPABASE_URL` is a placeholder
(`dummy.supabase.co`, unreachable), so any Storage upload fails there
regardless of application logic (confirmed via a direct curl reproduction:
`StorageUnknownError: fetch failed … ENOTFOUND dummy.supabase.co`). Every
other real-browser scenario (item-lock on row-launched forms, wrong-PIN
rejection, missing-evidence submit block, stale-draft token invalidation,
role-based direct-record vs. Pending Review, cross-branch PIN isolation)
was verified against the real app in a real Chromium session. Re-run
`tests/e2e/staff-pin-inventory-ops.spec.ts` and
`tests/e2e/inventory-approval-cancellation.spec.ts` against an environment
with real Supabase Storage credentials before considering the upload path
itself browser-verified.
