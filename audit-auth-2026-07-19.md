# Auth & Bounce-Back Audit — 2026-07-19

## 1. EXECUTIVE SUMMARY

Audited login, refresh rotation, middleware routing, client session restore, RBAC, cookies, and logout via targeted grep + 10 file reads (no subagents, no full-repo dumps). RBAC (A7) came back clean — all 18 routers pair `authenticate` with an appropriate role guard where one is expected; `notifications.router.ts`'s 3 routes are intentionally guard-free (personal inbox, scoped server-side). Role strings are consistent (`super_admin`/`supervisor`/`staff`) between `packages/shared/src/constants/roles.ts`, `middleware.ts`, and `authorize.ts`.

The two CRITICAL findings both live in `apps/web/hooks/use-auth.ts`'s `restoreSession()` — the client-side twin of the exact transient-error bug the middleware was just fixed for (this session's `ae41a66`), except nobody applied the same fix on the client. That's the highest-value fix: it can silently undo tonight's server-side work.

- **CRITICAL: 2** — unhandled-rejection permanent loading hang; client bounces to /login on transient refresh errors that middleware now correctly ignores.
- **HIGH: 4** — redundant double refresh-rotation per hard reload; no cross-tab logout sync; no deep-link return-to; bfcache can replay authenticated UI after logout.
- **MEDIUM: 3** — see below, one-liners only.
- **LOW/hardening: 3** — see below, one-liners only.

## 2. FINDINGS

### CRITICAL

1. **`apps/web/hooks/use-auth.ts:63-95`** — `restoreSession()` calls `apiClient()` with no `try/catch`. `apiClient` (`apps/web/lib/api-client.ts`, the outer `fetch` around line 97) has no catch around its own network call either, so any DNS/timeout/offline failure during mount rejects the promise. It's invoked as `void restoreSession()` (line 109), so the rejection is unhandled and `setLoading(false)` never runs — `isLoading` stays `true` forever. Anything gated on it (`withAuth.tsx:31`: `if (isLoading) return null`) hangs indefinitely until a manual reload.
2. **`apps/web/hooks/use-auth.ts:71-94`** — on any refresh failure that *isn't* a thrown network error either (bad response, transient 500, the exact `P2028` class of error just fixed server-side in `middleware.ts:96-119`'s `resolveAccessToken`), the code falls straight to `setLoading(false)` with `isAuthenticated` left `false`. `with-auth.tsx:24-26` then does `router.replace('/login')` on `!isAuthenticated`. Net effect: middleware fails open (per tonight's fix) and lets the page load, but the client hydrates, hits the same transient error with no retry/fail-open logic, and bounces anyway — reproducing the bug this session already fixed once, just one layer up.

### HIGH

3. **`apps/web/hooks/use-auth.ts:97-114` vs `apps/web/middleware.ts`** — on every hard reload of a protected route, middleware's `resolveAccessToken` *and* the client's mount-effect `restoreSession()` each independently call `/api/auth/refresh` and rotate the single-use refresh token, sequentially. Harmless correctness-wise (rotation cache/sequencing handles it) but doubles DB/advisory-lock load on every reload for no functional benefit — the in-memory-token check at line 105 only prevents this on client-side nav, not hard reloads.
4. **No cross-tab logout sync** (`apps/web/stores/auth.store.ts`, `apps/web/hooks/use-auth.ts`) — no `storage`/`BroadcastChannel` listener anywhere. Tab A's logout clears/revokes the shared refresh cookie, but Tab B's Zustand state and its own still-valid (non-blacklisted) access token keep it looking and acting authenticated until that access token's natural TTL (`JWT_ACCESS_TOKEN_TTL`, 15m) expires. Scenario A6-#4, confirmed.
5. **No return-to / deep-link preservation** — `apps/web/middleware.ts:162` redirects unauthenticated requests straight to `/login` with no `?next=`; `login-form.tsx:55-56` always routes to `ROLE_DASHBOARD_PATHS[user.role]`, never back to the originally-requested URL. Scenarios A6-#8/#9, confirmed.
6. **No bfcache guard** — no `pageshow`/`persisted` handler and no `Cache-Control: no-store` found anywhere in `apps/web`. Since `useAuthStore` is in-memory JS state, a back-navigation bfcache restore after logout can replay a fully "authenticated" UI verbatim until the next network call 401s. Scenario A6-#7, confirmed.

### MEDIUM (3)
- `apps/web/lib/api-client.ts` — the primary `apiClient()` fetch has no `try/catch` (unlike its sibling `refreshAccessToken()`, which does); a network throw during a normal mutation surfaces as an unhandled rejection rather than a typed `ApiResponse` error.
- The "skip restore if token present" guard (`use-auth.ts:105`) only checks in-memory state, so it doesn't actually prevent finding #3's double rotation on the one case (hard reload) that matters.
- `login-form.tsx`'s `parseLoginError` parses `err.message` as JSON to recover `minutesRemaining`; fragile implicit coupling to `AuthError`'s message serialization.

### LOW / hardening (3)
- `role-guard.tsx`/`with-auth.tsx`/`branch-guard.tsx` correctly self-document as non-security-boundary UI guards — confirmed no false sense of security, no action needed.
- Rotation cache TTL (10s, `auth.repository.ts:7`) vs. middleware's `REFRESH_RETRY_DELAY_MS` (300ms) — no bug, just noting the relationship for future readers.
- `use-auth.ts`'s `logout()`/`logoutAll()` don't wrap their `apiClient()` calls in `try/catch` — a network failure on the logout call itself skips `clearAuth()`/`router.push('/login')`, leaving the user stuck client-side "logged in" despite intending to log out.

## 3. NOT YET DONE (awaiting direction)
Phase 3 (fix diffs), Phase 4 (tests), Phase 5 (deploy plan) per the brief's own instruction to stop after Phase 1 and confirm scope.

## 4. TOKEN USAGE JUSTIFICATION
Tools used: Read (10 calls, all under the 5-full-file soft cap except where files were small/targeted — middleware.ts, config/index.ts, auth.repository.ts, csrf-guard.ts were pre-loaded by the harness on context restore, not fresh reads I initiated), Bash (grep/cat, batched). No Agent/subagent, no MCP, no skill invocation — the task brief's own tool policy (Read/Grep/Glob/Bash only) takes precedence over the default skill-invocation reminder, per this session's standing instruction hierarchy.
