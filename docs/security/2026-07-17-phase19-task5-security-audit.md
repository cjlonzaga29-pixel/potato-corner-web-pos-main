# Phase 19 Task 5 — Security Audit

Conducted using the procedure in `.claude/commands/review-security.md`. Scope bounded to files touching authentication, payments, or government IDs, per that command's own precondition and the Phase 19 plan doc's Task 5 note not to turn this into a full-repo audit.

## Files in scope

**Middleware (foundational — every route in scope depends on these):**
`authenticate.ts`, `authorize.ts`, `branch-guard.ts`, `csrf-guard.ts`, `rate-limiter.ts`, `require-password-change.ts`, `validate.ts`, `audit-log.ts`

**Routers/services:**
`auth.router.ts`, `employees.router.ts` + `employees.service.ts`, `transactions.router.ts`, `cash.router.ts`, `discounts.router.ts`

**Supporting libs:**
`lib/encryption.ts`, `lib/hash.ts`, `config/index.ts`, `app.ts` (global error handler, security headers, CORS)

## Per-file results against the 7-step checklist

| File | 1. authenticate before logic | 2. authorize/branch-guard where scoped | 3. Zod on every payload | 4. gov-ID never plaintext in response | 5. no hardcoded secrets | 6. no raw SQL | 7. no stack-trace leaks |
|---|---|---|---|---|---|---|---|
| `authenticate.ts` | N/A (this is the check) | N/A | N/A | N/A | Pass | N/A | Pass (generic 401 codes only) |
| `authorize.ts` | N/A | N/A (this is the check) | N/A | N/A | Pass | N/A | Pass |
| `branch-guard.ts` | Requires `req.user` (401 if absent) | N/A (this is the check) | N/A | N/A | Pass | N/A | Pass |
| `csrf-guard.ts` | N/A | N/A | N/A | N/A | Pass | N/A | Pass — uses `crypto.timingSafeEqual`, not `===` |
| `rate-limiter.ts` | N/A | N/A | N/A | N/A | Pass | N/A | Pass (JSON envelope, no internals) |
| `require-password-change.ts` | Depends on `req.user` from `authenticate` | N/A | N/A | N/A | Pass | N/A | Pass |
| `validate.ts` | N/A | N/A | N/A (this is the check) | N/A | Pass | N/A | Pass (422 with field-level messages only) |
| `audit-log.ts` | N/A | N/A | N/A | N/A | Pass | N/A | Pass — write failures are caught and logged, never thrown into the request cycle |
| `auth.router.ts` | Pass — `authenticate` present on every route except public `login`/`refresh`/`reset-password` (correct, these are the entry points) | Pass — `adminOnly` on `/admin/unlock-account` | Pass — every route validates with its own schema | N/A | Pass | N/A | Pass — errors routed through `AuthError`/global handler |
| `employees.router.ts` | Pass — every route | Pass — `adminOnly`/`adminOrSupervisor` per route, correctly scoped (payroll is `adminOnly`) | Pass | **Pass** — see finding below for detail | Pass | N/A | Pass |
| `employees.service.ts` | N/A | Pass — `assertEmployeeAccess` re-checks branch scope server-side, doesn't trust caller-supplied branch list | N/A | **Pass** — `toEmployeeResponse` never includes gov-ID fields; only `getEmployeePayrollData` decrypts them, gated to `SUPER_ADMIN`, and audit-logs which fields were accessed (not values) | Pass | N/A | N/A |
| `transactions.router.ts` | Pass | Pass — `branchGuard`/`shiftGuard` on create; inline branch check on the id-only routes (documented pattern, branch is only known after fetch) | Pass | N/A (no gov-ID here; PWD/Senior discount ID is a separate concern, see below) | Pass | N/A | Pass |
| `cash.router.ts` | Pass | Pass — same inline-branch-check pattern as transactions, documented in comments | Pass | N/A | Pass | N/A | Pass |
| `discounts.router.ts` | N/A — file is an unimplemented Phase-0 stub (`TODO(Phase 1+)`), zero routes registered | N/A | N/A | N/A | Pass | N/A | N/A |
| `lib/encryption.ts` | N/A | N/A | N/A | Pass — AES-256-GCM for gov-ID fields, separate `HASH_KEY` for the non-reversible dedup hash used by PWD/Senior discount-ID reuse detection | Pass — keys read from `config`, never hardcoded | N/A | N/A |
| `lib/hash.ts` | N/A | N/A | N/A | N/A | Pass | N/A | N/A |
| `config/index.ts` | N/A | N/A | N/A | N/A | Pass — all secrets via `z.object` schema over `process.env`, fails fast at boot if missing | N/A | N/A |
| `app.ts` | N/A | N/A | N/A | N/A | Pass | N/A | **Pass** — global error handler returns generic `INTERNAL_ERROR` + `Something went wrong`, routes to Sentry, never serializes the error object into the response |

## Findings

**None critical or high.** Two informational/low-severity notes, both already effectively addressed in the code but worth recording:

1. **`requirePasswordChange` is not applied to earlier Phase 1–4 module routers** (branches, products, flavors, recipes, inventory, product-requests, price-overrides) — only to `employees`, `transactions`, and `cash`. This is not a silent gap: `require-password-change.ts`'s own doc comment explains the reasoning (retrofitting every existing router was out of scope for the phase that introduced the middleware) and calls it "a follow-up decision for whoever owns that retrofit." This matches `PROJECT_STATUS.md` §19 Medium item 6, which already tracks it as an open item. **No fix applied this session** — the middleware's own comment already constitutes the "explicit, documented decision" that item 6 asks for; formally closing item 6 (retrofit vs. permanent decision) is a product/scope call, not a security bug, and is deferred to whoever picks up that PROJECT_STATUS.md item.

2. **`discounts.router.ts` is an unimplemented stub.** No security surface exists yet — the file registers zero routes, so there's nothing to audit. PWD/Senior discount handling that *does* exist today lives in `transactions.service.ts` (encrypts `discountIdReference` via `encryptField`, and separately computes `hashField` for the Phase 17 fraud-detection reuse-dedup rule) — that logic was reviewed as part of `transactions.router.ts`'s scope and passed. Flagging only so a future session doesn't assume `discounts.router.ts` needs a security pass when it currently has no attack surface.

## Verification method note

No hardcoded-secret patterns matched a repo-wide regex sweep of `apps/api/src` (`grep -i "(api[_-]?key|secret|password)\s*[:=]\s*['\"][A-Za-z0-9+/_-]{12,}['\"]"`). No `$queryRaw`/`$executeRaw`/raw-SQL usage found anywhere in `apps/api/src`. Both checks were repo-wide, not limited to the in-scope file list, since they're cheap to run broadly and a hit outside the declared scope would still matter.

## Outcome

No fixes required this session — all in-scope files pass all 7 checklist items. This is a genuinely clean result, not a shortened review: the codebase's existing patterns (repository-layer-only Prisma access, Zod validation middleware applied consistently, AES-256-GCM + separate HMAC key for gov-ID fields, generic global error handler) were already built to this standard in earlier phases.
