# Phase 19 — Production Hardening Debt

Captured items discovered during earlier phases that Phase 19 should address.

## Development Environment (from Phase 18)

### Prisma migrations on Windows — DIRECT_URL requirement
- `prisma migrate dev` and `prisma migrate diff --from-url` hang silently
  when `DIRECT_URL` points at PgBouncer transaction-mode pooler (port 6543)
- Root cause: transaction-mode pooler cannot grant session-level operations
  Prisma migrate requires (CREATE DATABASE for shadow DB, advisory locks)
- Fix per environment:
  - Local dev on IPv4-only network: `DIRECT_URL` = Session Pooler (5432)
  - CI (GitHub Actions, IPv6-capable): `DIRECT_URL` = raw direct connection (5432)
  - Runtime `DATABASE_URL`: Transaction Pooler (6543) works for both
- Three-URL pattern per environment should be codified in `.env.example`

### Turbo access violation on Windows
- `turbo run type-check` crashes with `0xC0000005` access violation
- Reproduces in both Git Bash and native PowerShell — not a shell issue
- Workaround: `pnpm --filter @potato-corner/api run type-check` directly
- Needs investigation (turbo version / cache corruption / Windows compatibility)
  before relying on `pnpm type-check` root command in local dev

### Prisma commands under Git Bash / Node 24
- Known upstream issues: prisma/prisma#27300, #24975
- Not the root cause of Phase 18 Task 3's original hang (that was the
  DIRECT_URL/pooler-mode issue above), but worth documenting
- If encountered in future: run Prisma commands via native PowerShell

### Supabase dashboard "Last migration" indicator — needs confirmation, not yet verified
- Working hypothesis, **not yet confirmed**: the dashboard's Database →
  Migrations panel tracks Supabase-CLI migrations only, and since this
  project uses Prisma exclusively, the panel would show "No migrations"
  even when `_prisma_migrations` and the real schema are fully up to date
- `prisma migrate status` reports "Database schema is up to date! 14
  migrations found" against the project referenced by this repo's
  `SUPABASE_URL` (`nliuhztaezaujzgtsrwp`), which is strong but indirect
  evidence for the hypothesis
- Direct confirmation via `information_schema.tables` in the Supabase SQL
  Editor was requested and is still outstanding as of 2026-07-17 — do not
  treat this as settled until that comes back
- Once confirmed either way: if true, prefer `prisma migrate status` (or
  querying `_prisma_migrations` directly) over the dashboard panel for
  verifying migration state

## From Phase 17 handoff (previously identified, still open)
- Render vs Railway confusion in deploy-production.yml
- PROJECT_STATUS.md contradictions about deploy platform
- apps/web/.env.example references outdated Railway URL
- next.config.ts:15 comment references "Vercel vs Railway"
- railway.json + apps/api/Dockerfile status unclear vs CI workflow
- Postgres service container missing from CI (105 integration tests skip)
- Phase 12/14/15 verification audit needed
