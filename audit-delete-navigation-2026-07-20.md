# Product Catalog: Delete + Navigation Audit — 2026-07-20

Scope: commit `11994b7` (delete routes + UI wiring), production (`https://www.potatorenovare.com`, backend `srv-d9cok48js32c73dss310` on Render). Phase 1 (audit only) — no fixes applied.

## 1. Executive summary

- **Delete buttons are wired correctly.** Every delete affordance (product list row, product detail page, variant card, media remove) opens its confirm dialog and fires the right `DELETE` request with the right ID. The problem is not the UI wiring.
- **Root cause of "delete doesn't work": an access-token refresh race**, not a missing/broken route. Mutations (`POST`/`DELETE`) intermittently get `401 TOKEN_MISSING` on the first attempt. The client's single silent-retry-after-refresh (`apiClient`) usually recovers, but when it doesn't land in time the mutation fails outright with no further retry — from the user's side, click, dialog, confirm, then nothing visibly happens.
- **Navigation slowness is one slow backend call, not a waterfall.** `GET /api/products/:id` alone took ~4.9–5.1s in two separate runs, including for a near-empty draft product with no variants/image — pointing at something systemic in that endpoint (or its infra), not query complexity from the specific product's data. There's also no prefetch-on-hover or `<Link>`-based navigation, so every click pays this cost cold.
- **Two secondary bugs found along the way**, unrelated to delete/navigation but worth fixing: an unlabeled form field that also breaks the app's own testability, and a stale Socket.io host spamming CORS errors into the console every few seconds.
- **Housekeeping needed**: two disposable test products (`E2E Audit Delete <timestamp>`) are now live in the catalog from this audit's own runs — see §6.

## 2. Delete button root cause

**Evidence chain**, all against real live production, using only disposable test products created and destroyed by the audit itself:

1. Playwright network capture: clicking product-list "⋯ → Delete" opens the `AlertDialog`, and clicking Confirm fires `DELETE /api/products/:id` with the correct product ID. Same for variant-card Delete (`DELETE /api/products/:id/variants/:id`) and Media "Remove Image" (`DELETE /api/products/:id/image`). All three dialogs and handlers work exactly as coded.
2. The failure showed up one level earlier, on `POST /api/products` (create), but it's the same code path every mutation uses ([apps/web/lib/api-client.ts](apps/web/lib/api-client.ts)):
   - First attempt: `POST /api/products` → **401 `TOKEN_MISSING`** (captured client-side, ms=235 — an immediate rejection, not a timeout).
   - Render logs for the same window show the actual pattern:
     ```
     17:07:15  GET  /api/products                 401
     17:07:15  POST /api/auth/refresh              200
     17:07:15  POST /api/products                  401   <- retried request, still 401
     17:07:16-22  (7 more refresh calls fire, mostly 200, some overlapping)
     17:07:23  POST /api/products                  201   <- succeeds ~8s after the first click
     ```
     A second occurrence at 17:08:16–17:08:35 shows the same shape, worse: a refresh itself 401'd once, then ~19 more refresh calls fired within 15 seconds before a mutation finally landed with 201, ~19s after the user's click.
3. Root cause in [apps/web/lib/api-client.ts:106-118](apps/web/lib/api-client.ts#L106-L118): on a 401, `apiClient` calls `refreshAccessToken()` and retries the original request **exactly once** (`_isRetry` flag). If the retried request also 401s — which happens here, given the refresh storm in the logs — there is no second retry. The function just returns the 401 body to the caller. The mutation's `onError` shows a toast (`hooks/queries/use-products.ts`), but by then several seconds have passed and, per the confirm dialog's own logic, the failure is easy to miss.
4. Compounding this: [components/shared/confirm-dialog.tsx:47-56](apps/web/components/shared/confirm-dialog.tsx#L47-L56) `handleConfirm` awaits `onConfirm()` with no `catch` — when the mutation rejects, the rejection is unhandled inside the click handler (an uncaught promise rejection in the browser), even though `onError`'s toast still fires separately. Not fatal, but it means a real error surfaces as a swallowed rejection plus an easy-to-miss toast, not a clear failure state in the dialog itself (the dialog just closes-or-doesn't with a spinner reset).

**Classification against the brief's taxonomy (§ STEP 6):** (b) — click fires the request, gets `401`, and self-heals unreliably. Not (a) broken handler, not (c) missing route, not (d) 500, not (f) wrong ID.

Why the refresh races so hard is a Phase-2 question (candidates: token TTL too short for real usage patterns, `refreshInFlight` dedup not actually preventing concurrent refresh calls across multiple in-flight requests, clock skew between client and Render). Flagging for whoever picks up Phase 2 rather than diagnosing further under an audit-only budget.

## 3. Navigation slowness root cause

Two independent runs, both logged-in fresh, both single API call on the critical path (no waterfall):

| Run | Product | `GET /api/products/:id` | Total click→render |
|---|---|---|---|
| 1 | existing catalog product ("Drinks") | 4977ms | 5106ms |
| 2 | disposable draft product, no variants, no image | 4934ms | ~4950ms (same shape) |

- Only one request is on the critical path — this isn't N+1 API calls from the frontend, it's one slow response.
- The near-empty draft product taking essentially the same time as a real catalog product rules out "expensive joins over a specific product's data" as the primary explanation and points at something endpoint- or infra-wide (cold Prisma connection, unconditional expensive shared query, Render instance sizing under real latency, etc.) — needs backend-side profiling in Phase 2.
- Code check confirms no mitigations exist: no `prefetch`/`force-dynamic`/`revalidate` usage anywhere under `admin/products` ([grep](apps/web/app/(admin)/admin/products), no hits), and the row click is a plain `onClick` → `router.push()` inside [components/shared/data-table/data-table.tsx:156](apps/web/components/shared/data-table/data-table.tsx#L156) — not a Next.js `<Link>`, so there's no automatic viewport-prefetch either. `useProduct()`'s `staleTime` is 30s ([hooks/queries/use-products.ts:78](apps/web/hooks/queries/use-products.ts#L78)) but that only helps on a second visit to the same product within the window; the first click always pays the full ~5s cold.

## 4. Secondary findings (not in original scope, surfaced during the audit)

- **Unlabeled Base Price field** — [components/shared/forms/currency-input.tsx](apps/web/components/shared/forms/currency-input.tsx): `CurrencyInput` has a fixed prop signature (`value/onChange/onBlur/disabled/placeholder`) and doesn't forward `id`/`aria-*` props, so the `FormControl` wrapper's Slot-injected `id`/`aria-labelledby` never reaches the underlying `<Input>`. The "Base Price" field in the variant form is unlabeled to assistive tech and to `getByLabel`-style test tooling — this is what stalled this audit's variant-creation step for 90s before timing out. Real accessibility bug independent of delete/navigation.
- **Socket.io pointed at a stale host**: every page load spams the console with CORS failures — `SOCKET_URL` resolves to `api-production-78f6.up.railway.app`, which rejects the `www.potatorenovare.com` origin (its CORS allow-list still says `potato-corner-pos.vercel.app`). This is unrelated to the Render backend that actually serves `/api/*` (confirmed via [next.config.ts:27](apps/web/next.config.ts#L27) — `NEXT_PUBLIC_API_URL` proxy, separate from `NEXT_PUBLIC_SOCKET_URL`) — it looks like a leftover/misconfigured env var from an earlier deployment, and likely means realtime features are silently non-functional in production right now.

## 5. Recommended fixes, ranked by impact

1. **Fix the mutation 401 race** — either retry more than once with backoff, or (better) block outgoing requests while a refresh is in-flight instead of just deduping the refresh call itself, so a mutation never races a refresh that's already resolving. This directly fixes "delete doesn't work" (and silently affects every other mutation in the app, not just delete).
2. **Add error surfacing to `ConfirmDialog`** — catch `onConfirm()` rejections and show inline dialog state (not just an easy-to-miss toast + an unhandled rejection), so a future auth hiccup like this one is visibly a failure to the user, not a silent no-op.
3. **Profile `GET /api/products/:id`** on the Render backend — the flat ~5s regardless of product size is the single biggest navigation-speed lever available.
4. **Add prefetch-on-hover or switch to `<Link>` with Next.js prefetch** for product rows, to hide backend latency once #3 is addressed.
5. **Fix `SOCKET_URL`** to point at the real backend/CORS-allowed origin.
6. **Forward `id`/`aria-*` through `CurrencyInput`** so Base Price (and any other currency field) is properly labeled.

## 6. Housekeeping — action needed from you

This audit's own runs left **two disposable test products live in the catalog**: `E2E Audit Delete <timestamp>` (draft status, no variants/image). One of them is currently sorting to the *first row* of the default product list. These exist because the auth-refresh race in §2 meant product creation silently succeeded via the client's background retry even after the test itself had already failed and moved on — so the delete step in the same test never ran.

I built a cleanup test (`tests/e2e/product-catalog-audit-cleanup.spec.ts`) that searches for and deletes them via the real list-row Delete action, but running it against production got blocked by your Bash permission classifier (production-write guard) — same pattern as before with direct DB writes. Please run it yourself:

```
cd potato-corner-web-pos-main-main
npx playwright test --config=tests/e2e/playwright.audit.config.ts -g "delete orphaned"
```

Audit scaffolding to remove once you're satisfied (not deleted yet, in case you want to re-run anything):
- `tests/e2e/product-catalog-audit.spec.ts`
- `tests/e2e/product-catalog-audit-cleanup.spec.ts`
- `tests/e2e/playwright.audit.config.ts`
- this report

## 7. Trace files

None — trace/screenshot/video were kept off for this run (live pilot credentials; see `playwright.audit.config.ts` header comment). Diagnosis came from `page.on('request'/'response')` capture inline in the spec (console output above) plus `render logs`.

Waiting for your review before Phase 2 (fix scope).
