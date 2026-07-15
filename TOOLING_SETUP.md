# Potato Corner Web POS — CLI Tools, Connectors & VS Code Extension Setup

This guide covers everything needed to get a machine ready to develop, test, and deploy the **Potato Corner Enterprise Web POS & Branch Management Platform** (`potato-corner-web-pos-main`).

Stack recap (from `README.md` / `.claude/CLAUDE.md`):
- **Monorepo:** pnpm workspaces + Turborepo, Node.js ≥24
- **Frontend (`apps/web`):** Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS v3, shadcn/ui
- **Backend (`apps/api`):** Express 5, TypeScript, Prisma ORM, Socket.io
- **Database:** PostgreSQL via **Supabase Pro**
- **Queue/Cache:** **BullMQ** + **Upstash Redis**
- **Email:** Resend (or SMTP)
- **Observability:** Sentry, PostHog
- **Planned deploy targets:** Vercel (web) + Render (api) — per the `TODO` notes in `.github/workflows/deploy-*.yml`, not yet provisioned (Phase 0 complete, Phase 1 in progress)

Tools are grouped as **Core** (this project actively uses or is planned to use them) and **Optional/Alternative** (useful general-purpose tooling requested for completeness — e.g. if you swap Render for Railway, or want local Docker infra instead of hosted Supabase/Upstash in dev).

---

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 24 (per `engines` in `package.json`) | Runtime for both apps |
| pnpm | 11.10.0 (pinned via `packageManager`) | Monorepo package manager |
| Git | Latest | Version control |

### Install Node.js 24

```powershell
# Recommended on Windows: nvm4w (CoreyButler.NVMforWindows), not the plain OpenJS MSI.
# The direct MSI can leave a stale "installed" registry entry with no node.exe on disk
# if the install is interrupted; nvm4w avoids that and lets you switch versions cleanly.
winget install CoreyButler.NVMforWindows
nvm install 24
nvm use 24
node -v   # v24.x — should resolve to C:\nvm4w\nodejs\node.exe (`Get-Command node`)
```

### Install pnpm (pinned to the version this repo uses)

```powershell
corepack enable
corepack prepare pnpm@11.10.0 --activate
pnpm -v   # should print 11.10.0
```

> **Windows non-admin gotcha:** `corepack prepare ... --activate` writes into `C:\Program
> Files\nodejs\`, which fails with `EPERM` in a non-elevated shell. If that happens:
> ```powershell
> npm config set prefix "$env:APPDATA\npm"
> [Environment]::SetEnvironmentVariable("Path", "$env:APPDATA\npm;" + [Environment]::GetEnvironmentVariable("Path","User"), "User")
> npm install -g pnpm@11.10.0
> ```
> **Also:** after any global npm install (pnpm, vercel, supabase, etc.), open a **new**
> terminal/tool session — the current one won't see the updated PATH until its process
> environment is refreshed.

### Install Git

```powershell
winget install Git.Git
```

---

## 2. Core CLI Tools

### 2.1 GitHub CLI (`gh`)
Used for PR creation/review, matches `.github/CODEOWNERS`, `pull_request_template.md`, and the CI/deploy workflows in `.github/workflows/`.

```powershell
winget install GitHub.cli
gh auth login
```

### 2.2 Vercel CLI
Web app (`apps/web`) is the planned Vercel deploy target.

```powershell
npm install -g vercel
vercel login
# From apps/web:
vercel link
```

### 2.3 Supabase CLI
The project's Postgres database is Supabase Pro; Prisma connects via `DATABASE_URL` / `DIRECT_URL` in `.env`.

```powershell
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
```

Useful commands once linked:
```powershell
supabase db pull        # pull remote schema for comparison against prisma/schema.prisma
supabase db push        # push local migrations (if managing schema outside Prisma)
supabase status
```

> Note: this project migrates its schema through **Prisma migrations** (`pnpm exec prisma migrate deploy`), not `supabase db push`. Use the Supabase CLI mainly for project management, storage buckets, and inspecting the hosted instance — don't let it drift from `apps/api/prisma/migrations/`.

### 2.4 Prisma CLI
Already a devDependency of `apps/api` (`prisma@^5.22.0`), invoked via `pnpm exec` — no separate global install required, but a global copy is convenient for ad-hoc use.

```powershell
npm install -g prisma
# Project-local usage (preferred, matches package.json scripts):
cd apps/api
pnpm prisma:generate      # prisma generate
pnpm prisma:migrate       # prisma migrate dev
pnpm prisma:seed          # tsx prisma/seed.ts
```

### 2.5 Docker CLI + Docker Desktop
Not currently wired into CI, but recommended for running a local Postgres/Redis pair so you don't have to burn Supabase/Upstash quota during early development, and for eventually containerizing `apps/api` for Render/Railway.

```powershell
winget install Docker.DockerDesktop
docker --version
docker compose version
```

> **WSL2 prerequisite:** Docker Desktop on Windows needs WSL2 installed and enabled
> *first*, or its engine will start the GUI but sit stuck waiting on the backend VM
> indefinitely (`docker ps` → `Error response from daemon: Docker Desktop is unable to
> start`). Check with `wsl --status`; if it reports "not installed", you must run (from
> an **elevated/Administrator** PowerShell — this cannot be done from a normal user
> session):
> ```powershell
> wsl --install --no-distribution
> ```
> then **restart Windows** to complete the WSL2 kernel/VM Platform setup before Docker
> Desktop's engine will come up.

Example local infra (create `docker-compose.dev.yml` at the repo root if you want this):
```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: password
      POSTGRES_DB: potato_corner_dev
    ports: ["5432:5432"]
  redis:
    image: redis:7
    ports: ["6379:6379"]
```

---

## 3. Optional / Alternative Infrastructure CLIs

These aren't part of the current approved stack (`.claude/CLAUDE.md` → "Do Not: Add libraries not in the approved stack" applies to app *code*, but these are fine as personal/ops tooling). Install them if your workflow needs them.

### 3.1 Railway CLI
Alternative to Render for hosting `apps/api` (Render is what the deploy workflow TODOs currently name).

```powershell
npm install -g @railway/cli
railway login
```

### 3.2 Netlify CLI
Alternative to Vercel for hosting `apps/web` if that decision changes.

```powershell
npm install -g netlify-cli
netlify login
```

### 3.3 Firebase CLI
Not used by this project's approved architecture (Supabase covers auth/DB/storage), but useful if push notifications (FCM) or a secondary Firebase project is ever introduced.

```powershell
npm install -g firebase-tools
firebase login
```

### 3.4 AWS CLI
Not part of the current stack, but useful if S3-compatible object storage or SES becomes a requirement beyond Supabase Storage / Resend.

```powershell
winget install Amazon.AWSCLI
aws configure
```

### 3.5 Render
Render has no widely-used standalone CLI equivalent to Vercel/Railway — provisioning and env var management is done via the Render Dashboard or `render.yaml` (Blueprints) checked into the repo. Add a `render.yaml` when Phase 1+ actually provisions the API host.

### 3.6 Sentry CLI
Useful once `SENTRY_DSN` (see `.env.example`) is actually populated, for uploading source maps in CI.

```powershell
npm install -g @sentry/cli
sentry-cli login
```

---

## 4. VS Code Extensions

The repo already declares recommended extensions in [`.vscode/extensions.json`](.vscode/extensions.json). Install them all with:

```powershell
code --install-extension dbaeumer.vscode-eslint
code --install-extension esbenp.prettier-vscode
code --install-extension bradlc.vscode-tailwindcss
code --install-extension Prisma.prisma
code --install-extension eamodio.gitlens
code --install-extension GitHub.copilot
code --install-extension rangav.vscode-thunder-client
code --install-extension usernameheren.errorlens
code --install-extension christian-kohler.path-intellisense
code --install-extension cweijan.vscode-postgresql-client2
code --install-extension mikestead.dotenv
code --install-extension vitest.explorer
code --install-extension ms-playwright.playwright
code --install-extension pmneo.tsimporter
```

| Extension | ID | Why it matters here |
|---|---|---|
| ESLint | `dbaeumer.vscode-eslint` | Enforces `apps/api/eslint.config.js` / `packages/config` rules |
| Prettier | `esbenp.prettier-vscode` | Formats per `.prettierrc` (with `prettier-plugin-tailwindcss`) |
| Tailwind CSS IntelliSense | `bradlc.vscode-tailwindcss` | Class autocomplete for Tailwind v3 + shadcn/ui |
| Prisma | `Prisma.prisma` | Syntax highlighting/formatting for `apps/api/prisma/schema.prisma` |
| GitLens | `eamodio.gitlens` | Blame/history — useful given Conventional Commits requirement |
| GitHub Copilot | `GitHub.copilot` | AI pair programming |
| Thunder Client | `rangav.vscode-thunder-client` | Manual testing of Express routes in `apps/api/src/modules/*` |
| Error Lens | `usernameheren.errorlens` | Inline TS/ESLint errors — pairs well with strict mode |
| Path Intellisense | `christian-kohler.path-intellisense` | Import path autocomplete across the monorepo |
| PostgreSQL Client2 | `cweijan.vscode-postgresql-client2` | Inspect Supabase Postgres directly from VS Code |
| DotENV | `mikestead.dotenv` | Syntax highlighting for `.env` / `.env.example` |
| Vitest Explorer | `vitest.explorer` | Run/debug `*.test.ts` and `*.integration.test.ts` files inline |
| Playwright Test for VS Code | `ms-playwright.playwright` | Run/debug `tests/e2e/` suites |
| TS Importer | `pmneo.tsimporter` | Auto-import types/utilities from `packages/shared` |

### Recommended additions (not yet in `.vscode/extensions.json`)

| Extension | ID | Why |
|---|---|---|
| Docker | `ms-azuretools.vscode-docker` | If you adopt the local Docker Compose setup above |
| YAML | `redhat.vscode-yaml` | Editing `.github/workflows/*.yml`, future `render.yaml` |
| GitHub Actions | `github.vscode-github-actions` | Inline validation for the CI/deploy workflows |
| Even Better TOML | `tamasfe.even-better-toml` | Editing `apps/api/prisma/migrations/migration_lock.toml` |

```powershell
code --install-extension ms-azuretools.vscode-docker
code --install-extension redhat.vscode-yaml
code --install-extension github.vscode-github-actions
code --install-extension tamasfe.even-better-toml
```

---

## 5. Project-Specific Setup Walkthrough

```powershell
# 1. Clone and enter the repo
git clone <repo-url> potato-corner-web-pos
cd potato-corner-web-pos

# 2. Pin toolchain
corepack enable
corepack prepare pnpm@11.10.0 --activate
nvm use 24   # or ensure `node -v` reports >=24

# 3. Install all workspace dependencies (root, apps/web, apps/api, packages/*)
pnpm install

# 4. Configure environment
cp .env.example .env
# Fill in real values for: DATABASE_URL/DIRECT_URL (Supabase), SUPABASE_URL/ANON_KEY/
# SERVICE_ROLE_KEY, JWT_PRIVATE_KEY/PUBLIC_KEY (RS256 keypair), JWT_REFRESH_SECRET
# (min 32 chars — required by apps/api/src/config/index.ts's zod schema but NOT listed
# in .env.example, easy to miss), ENCRYPTION_KEY (32-byte base64), REDIS_URL (Upstash),
# RESEND_API_KEY or SMTP_*, SENTRY_DSN, NEXT_PUBLIC_POSTHOG_KEY/HOST as they become available.
#
# IMPORTANT — Supabase DATABASE_URL/DIRECT_URL: the direct connection host
# (db.<ref>.supabase.co:5432) resolves to an IPv6-only address on new Supabase
# projects. If your network/machine has no IPv6 route (common on home ISPs/Windows),
# Prisma will fail with "Can't reach database server" even though credentials are
# correct. Use the IPv4-compatible Session Pooler string instead — from the Supabase
# dashboard: Project Settings -> Database -> Connection string -> "Session pooler" tab
# (format: postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres)
#
# Prisma CLI reads .env from apps/api/ (its own cwd when run via `pnpm --filter api`),
# NOT the repo root — copy the root .env there too:
cp .env apps/api/.env   # already gitignored via the root `.env*` pattern

# 5. Generate an RS256 keypair for JWT_PRIVATE_KEY / JWT_PUBLIC_KEY if you don't have one
openssl genrsa -out jwt-private.pem 2048
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem

# 6. Generate a 32-byte base64 ENCRYPTION_KEY
openssl rand -base64 32

# 7. Link Supabase project (once a project exists)
supabase login
supabase link --project-ref <your-project-ref>

# 8. Apply Prisma migrations and seed data
cd apps/api
pnpm prisma:generate
pnpm prisma:migrate
pnpm prisma:seed
cd ../..

# 9. Build the shared package once before first run — apps/web and apps/api both
#    import @potato-corner/shared's compiled output (dist/), and turbo's `dev` task
#    (unlike `build`) has no dependsOn, so it won't build workspace deps for you.
pnpm --filter @potato-corner/shared build

# 10. Run the full dev environment (web + api via Turborepo)
pnpm dev
# apps/web -> http://localhost:3000 (falls back to next free port, e.g. 3002, if taken)
# apps/api -> http://localhost:4000

# 11. Install Playwright browsers for e2e tests
pnpm exec playwright install --with-deps

# 12. Verify everything before committing (mirrors CI in .github/workflows/ci.yml)
pnpm type-check
pnpm lint
pnpm test
pnpm build
```

---

## 6. Deployment Setup (per current `.github/workflows/deploy-*.yml` plans)

These pipelines currently run `type-check`, `lint`, `test`, `build`, and `prisma migrate deploy` against `STAGING_DATABASE_URL` / `PRODUCTION_DATABASE_URL` GitHub Environment secrets, then stop at a `TODO` — actual hosting isn't provisioned yet. When that's ready:

```powershell
# Vercel (apps/web)
vercel login
cd apps/web
vercel link
vercel env pull .env.local     # sync Vercel env vars locally
vercel --prod                  # manual deploy; CI can also call this via a token

# Render (apps/api) — no CLI; commit a render.yaml Blueprint and connect
# the GitHub repo in the Render Dashboard, or use Railway as an alternative:
railway login
railway link
railway up
```

Required GitHub Actions secrets to add under **Settings → Environments** (`staging`, `production`): `STAGING_DATABASE_URL`, `PRODUCTION_DATABASE_URL`, plus `VERCEL_TOKEN`/`RENDER_API_KEY` (or `RAILWAY_TOKEN`) once those steps are added to the workflows.

> **Vercel + monorepo:** when linking/deploying `apps/web` from this pnpm workspace,
> set the project's **Root Directory** to `apps/web` in the Vercel dashboard (Settings →
> General). There's no CLI flag for this (`vercel project update` only supports
> `--build-command/--dev-command/--framework/--install-command/--output-directory`).
> Deploying *from* `apps/web` without this uploads only that subdirectory in isolation,
> which breaks pnpm's `workspace:*` protocol (`npm error Unsupported URL Type
> "workspace:": workspace:*`) since Vercel falls back to plain `npm install` without
> full monorepo context. Always run `vercel deploy`/`vercel --prod` from the **repo
> root** once Root Directory is set correctly.
>
> **Vercel + commit author email:** Vercel blocks a deploy if the triggering commit's
> git author email isn't valid/verified against your GitHub account ("Update your Git
> configuration with a valid email address..."). Fix with a **repo-scoped** (not
> `--global`) config change so it doesn't affect other projects on the machine:
> ```powershell
> git config user.email "your-verified-github-email@example.com"
> ```

---

## 7. Windows-Specific Troubleshooting

Issues actually hit setting this project up on a bare Windows machine, and their fixes:

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm dev` / `turbo run dev` crashes instantly with exit code `29` (`STATUS_ILLEGAL_INSTRUCTION`) | Turbo's Windows native binary (`@turbo/windows-64`) got corrupted during a flaky `pnpm install` (common on slower/unstable connections) | Bypass Turbo for local dev — run `pnpm --filter api dev` and `pnpm --filter web dev` directly in separate terminals. To actually fix Turbo, delete `node_modules/.pnpm/@turbo+windows-64@<version>` and reinstall — **do not** wipe the entire global pnpm store (`~/AppData/Local/pnpm/store`), that affects every project on the machine, not just this one |
| API crashes with `ERR_MODULE_NOT_FOUND: ...@potato-corner/shared/dist/index.js` | `packages/shared` was never compiled — Turbo's `dev` task has no `dependsOn`, unlike `build` | `pnpm --filter @potato-corner/shared build` once before first `pnpm dev` (see step 9 above) |
| Newly-installed CLI (`pnpm`, `vercel`, `supabase`, etc.) reports "not recognized" right after install | PATH was updated in the User/Machine registry hive, but the current shell process's environment was captured before that write | Open a **new** terminal window/session; or in PowerShell, force a refresh: `$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")` |
| `Test-NetConnection`/`Resolve-DnsName` shows the Supabase direct-connection host resolving to an `AAAA` (IPv6) record only, and Prisma reports `P1001: Can't reach database server` | No IPv6 route on this network/machine | Use the Supabase **Session Pooler** connection string instead of the direct connection (see §5 step 4) |
| `docker ps` → `Error response from daemon: Docker Desktop is unable to start`, engine log shows it endlessly retrying `_ping` | WSL2 isn't installed | Elevated PowerShell: `wsl --install --no-distribution`, then restart Windows |
| Background `pnpm dev` log file looks empty/garbled when read with plain-text tools (`cat`, bash `grep`) | PowerShell's `*>`/`Out-File` redirection defaults to UTF-16LE, not UTF-8 | Use a tool that decodes text properly (e.g. an editor, or `Get-Content -Encoding Unicode`) rather than byte-oriented `grep`/`cat` |

---

## 8. Quick Verification Checklist

```powershell
node -v          # >= 24
pnpm -v          # 11.10.0
git --version
gh --version
vercel --version
supabase --version
docker --version
code --list-extensions
```

If every command above resolves and `pnpm dev` boots both `apps/web` (port 3000) and `apps/api` (port 4000) without errors, the environment is ready for Phase 1+ work.
