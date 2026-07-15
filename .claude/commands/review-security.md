Review a file for security vulnerabilities, unauthorized access risks, input validation gaps, and secrets exposure.

**Purpose:** audit a specific file (usually a router, middleware, or anything touching authentication/payments/government IDs) against this project's security standards before it merges.

**Preconditions:** the file exists and is part of a diff or recently written code — this command reviews, it doesn't implement.

**Steps:**
1. Confirm every route in the file runs `authenticate` before any business logic, and `authorize`/`branch-guard` where the resource is role- or branch-scoped.
2. Confirm every request payload is validated with a Zod schema (`validate(schema)` middleware) before the handler body runs.
3. Check for raw SQL / string-interpolated queries — flag anything not going through Prisma's parameterized query builder.
4. Check that government ID fields (`sssNumber`, `philhealthNumber`, `tinNumber`, `pagibigNumber`) are never returned in a response body in plaintext, and that encryption/decryption goes through `apps/api/src/lib/encryption.ts`.
5. Check for secrets (API keys, connection strings, JWT keys) hardcoded instead of read from `process.env` via `apps/api/src/config/index.ts`.
6. Check that error responses don't leak stack traces or internal system details.
7. Report findings with file:line references, ranked most severe first.
