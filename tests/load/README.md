# Load Testing (k6)

Phase 19 Task 7. k6 is approved for this repo as of Phase 19 — see the
"Phase 19 addition" note in `docs/architecture/master-execution-plan.md`'s
stack table. No load-testing tool existed before this.

**Status: authored, not executed.** k6 is not installed in the environment
these scripts were written in, and there was no running API/Postgres/Redis
to point it at either (see `docs/architecture/phase-19-debt.md`). Install
k6 (`https://k6.io/docs/get-started/installation/`) and run these against a
real non-production environment before trusting any of this as a passing
check.

## Running

```
k6 run --env BASE_URL=https://staging.example.com tests/load/scenarios/auth-login.js
k6 run --env BASE_URL=https://staging.example.com tests/load/scenarios/transaction-create.js
```

**Never point `BASE_URL` at production**, and never at the same Supabase
project CI's integration tests use — both scripts write real rows (users,
products, transactions, shifts) through the real API, same as
`tests/e2e/fixtures/*`.

## Thresholds

Taken directly from `master-execution-plan.md`'s Monitoring section:
- 2s p95 for general API endpoints (`auth-login.js`)
- 500ms p95 for the transaction endpoint (`transaction-create.js`)

## Known constraints — read before running

Both scripts exist specifically to work *around* these, not despite them —
they aren't scripting mistakes, they're real properties of the API these
tests have to account for:

- **`auth-login.js`** is capped at 5 requests total. `loginLimiter`
  (`apps/api/src/middleware/rate-limiter.ts`) allows 10 login attempts per
  15 minutes **per IP**. A k6 run from one machine is one IP — anything
  beyond ~10 requests in that window measures the rate limiter, not login
  latency. Real login-scale testing needs either k6 Cloud's distributed-IP
  execution or a load-test environment with `loginLimiter` deliberately
  raised — an infrastructure decision, not something to fake in-script.
- **`transaction-create.js`** seeds one throwaway staff account per VU in
  `setup()`. `apiLimiter` caps authenticated requests at 100/min **per
  user** (`user_id`, not IP) — every VU sharing one seeded account would
  all share that one 100/min budget regardless of VU count.
- Neither script tears down its seeded data (extra products, k6-staff-\*
  accounts, an opened shift with a very large starting float). A load-test
  environment's reset strategy (fresh DB per run vs. a cleanup script) is a
  decision for whoever owns that environment.

## Not covered

- **Inventory deduction** has no synchronous HTTP endpoint of its own —
  `transactions.service.ts`'s `createTransaction` enqueues it onto BullMQ
  asynchronously and doesn't block the response on it. `transaction-
  create.js` exercises that pipeline indirectly by generating real
  transaction volume; there's no separate scenario for it.
- **WebSocket/Socket.io load** (Phase 13's realtime layer) isn't covered —
  k6 supports WS testing but this wasn't scoped into Task 7.
