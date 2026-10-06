# POS-PERF-P16 — Write-Gate Prerequisite Patch (built on P13)

## What this branch is

`pos-perf-p16-write-gate-prereq`, rooted at `ec0e097`
(`feat(pos-perf-p13): add opt-in transaction-vs-session pooler latency
comparison` — the commit currently live in production). This branch
contains **only** the operational write gate: no P15 stock-reservation
schema, no background inventory-deduction worker, no checkout-attempt
fencing, and no migration of any kind.

It exists because production is still on P13 — base P15
(`quantityReserved`) has never shipped (verified directly against Render's
deploy history; see `main`'s own
`docs/runbooks/pos-perf-p15-fast-checkout.md`, POS-PERF-P15R6 section,
which this branch does not carry since it predates that file). Before the
first P15 rollout ever happens, production needs a traffic-pause lever
that works on the free Render plan — this branch is that lever, buildable
and deployable completely independently of P15.

## What changed

- **Zero new migrations.** The gate's state is one row in the existing
  `system_settings` table (already live since before P13), key
  `operational_write_gate`. The table and its generic find/upsert-by-key
  repository helpers already existed for `security_policy`/
  `discount_policy`/`work_hours_policy` — this reuses that, it does not add
  anything to the schema.
- **`apps/api/src/middleware/write-gate.ts`** (new) — mounted in `app.ts`
  ahead of every router. Reads the gate's state fresh from Postgres on
  every non-GET request to a path it owns (so every instance — old and new
  alike, during a deploy-swap overlap — observes the same decision, with no
  in-process caching to go stale between them); 503s with a clear
  `SERVICE_WRITE_GATE_CLOSED` body when closed; lets a request through
  regardless if it carries both a valid Super-Admin token and a non-empty
  `X-Maintenance-Bypass` header (audit-logged as `MAINTENANCE_GATE_BYPASS`).
  Also tracks a per-process in-flight-request counter
  (`getActiveGatedRequestCount`) as the verified signal that closing the
  gate alone does not drain requests already running — see
  `write-gate.test.ts`'s dedicated describe block.
- **Scope on this (P13) codebase**: `/api/transactions/*` (checkout,
  sync-offline, hold-release, void, refund, receipt-printed — P13 has none
  of P15's `abandon`/`retry-inventory-deduction` routes, so there is
  nothing further to enumerate here), `/api/inventory/*`,
  `/api/product-inventory/*`, `/api/universal-inventory/*`,
  `/api/product-components/*`, `/api/branches/:branchId/inventory/*`,
  `/api/branches/:branchId/inventory-stock/*`. Every GET, and every other
  module (employees, branches core, auth, settings, reports, audit,
  notifications, …), is untouched.
- **`GET`/`PUT /api/settings/write-gate`** (new, `adminOnly` both verbs).
  `PUT` requires a `reason` when closing; no public/unauthenticated route
  can reach either verb (same `authenticate` + `adminOnly` +
  `requirePasswordChange` stack as every other admin settings route).
  Audit-logged on every change.

## Why this exact scope, and why it needed its own branch

See `main`'s `docs/runbooks/pos-perf-p16-write-gate.md` (written on the
sibling branch `pos-perf-p16-write-gate`, which carries this same patch
applied on top of the full P15 stack) for:

- the evidence trail of what was checked and rejected before choosing a
  DB-backed application-level gate (Render Maintenance Mode's paid-only
  restriction, unverified suspend/resume behavior, why an in-memory flag
  cannot satisfy "consistent across old/new instances during overlap");
- the full two-phase release sequence (this patch ships alone first; the
  gated P15 rollout follows, using the lever this patch adds);
- the verified drain procedure and the P15 worker-drain compatibility
  argument (not applicable to this branch directly, since it carries no
  worker, but relevant to why this patch's gate semantics were designed to
  be HTTP-layer-only from the start).

This branch is deliberately the smaller, reviewable half of that story —
it should be read together with the other branch's runbook, not as a
duplicate of it.

## Testing performed on this branch

- `apps/api`: `tsc --noEmit` clean, `eslint` clean on every changed/added
  file, full `vitest run` — 2571 passed, 1 pre-existing unrelated failure
  (`inventory-summary-export.test.ts`'s PDF-rendering timeout — reproduced
  independent of this change; a pre-existing flaky/slow test, not caused by
  the gate).
- `packages/shared`: `tsc` build clean, `eslint` clean.
- New test files: `apps/api/src/middleware/write-gate.test.ts` (27 cases —
  path/method scoping, open/default state, the narrowly-authorized bypass,
  and the in-flight counter) plus additions to
  `settings.service.test.ts`/`settings.router.test.ts` for
  `getWriteGate`/`setWriteGate` and the new router endpoints.
