# Potato Corner Enterprise Web POS & Branch Management Platform

Unified web application serving three role-based interfaces (Super Admin, Supervisor, Staff POS) for a multi-branch Philippine QSR franchise operation. One Next.js frontend, one Express backend, offline-first POS terminal, recipe-driven inventory, and full Philippine PWD/Senior Citizen VAT compliance.

## Stack

- **Frontend:** Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS v3, shadcn/ui, Magic UI, Zustand, TanStack Query v5, TanStack Table, React Hook Form + Zod, Recharts + Tremor, Sonner, Dexie.js, Socket.io client
- **Backend:** Node.js, Express 5, TypeScript, Prisma, PostgreSQL (Supabase), Postgres-native queue/locks/IDs (`pg-lock.ts`, `id-counter.ts`, `job-runner.ts`), Socket.io server, Zod
- **Monorepo:** pnpm workspaces + Turborepo

## Getting Started

```bash
pnpm install
cp .env.example .env
pnpm dev
```

- `apps/web` runs on http://localhost:3000
- `apps/api` runs on http://localhost:4000

## Project Structure

```
apps/web/       Next.js 15 frontend (all three role interfaces)
apps/api/       Express backend (modular monolith)
packages/shared Zod schemas and shared TypeScript types
packages/config Shared ESLint, TypeScript, and Prettier configuration
docs/           Architecture and operational documentation
tests/e2e/      Playwright end-to-end test suites
```

See [docs/architecture/](docs/architecture/) for the full approved architecture and business rules.

## Development Standards

TypeScript strict mode throughout. Zod validates every API request payload. No direct Prisma calls in routers — always through the repository layer. Conventional commits on every commit. See `.claude/CLAUDE.md` for the complete rule set.
