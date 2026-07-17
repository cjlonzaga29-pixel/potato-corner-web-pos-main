# Phase 19 Task 9 — Minimum-Device PWA Testing Checklist

**Locked device profile:** Android-class device, ~2GB RAM, 4-core CPU, Chrome stable. Playwright emulation (Moto G4 — closest built-in match to that spec) is the baseline; real-device verification is optional and does not block this checklist.

**Status: authored, not executed.** No local Postgres/Redis/live app this session (`phase-19-debt.md`) — automated items below have never been run. All "Pass/Fail" cells are blank pending a real run against a **production build** (see the critical precondition below).

## Critical precondition

`next.config.ts` disables the service worker under `next dev` (`disable: process.env.NODE_ENV === 'development'`). Every service-worker-dependent item below will fail against a dev server for that reason alone. **Run `next build && next start` (or the real deployed build) before testing any of these**, not the everyday local dev flow.

## Automated items — `tests/e2e/pwa-minimum-device.spec.ts`

| # | Item | Mechanism | Pass/Fail |
|---|---|---|---|
| 1 | Manifest is reachable and well-formed | `GET /manifest.json` returns 200, valid JSON, correct `name`/`start_url`/`icons` | _pending run_ |
| 2 | Manifest is actually linked from the page | `<link rel="manifest">` present in rendered HTML | _pending run_ |
| 3 | Manifest icons exist | `GET /icons/icon-{192,512}x192.png` | **Known-failing** — `test.fail()` annotated; real branded PNGs don't exist yet (Task 8 finding #4) |
| 4 | Service worker registers | `navigator.serviceWorker.getRegistrations().length > 0` | _pending run — requires production build_ |
| 5 | Offline shell load | Visit `/login` online, go offline, reload, confirm real app markup renders (not a browser error page) | _pending run — requires production build_ |
| 6 | Responsiveness under throttled CPU | 4x CPU throttling via CDP, time-to-interactive on `/login` logged (no hard threshold — none exists in the architecture docs for frontend paint time) | _pending run — informational, not pass/fail_ |

## Manual / real-device items (not Playwright-automatable)

These require actual hardware or are subjective enough that automating them would test the wrong thing. Real-device verification is optional per the locked profile, but if skipped, these stay explicitly "not verified," not silently assumed fine.

| Item | Why not automated | Status |
|---|---|---|
| "Add to Home Screen" prompt actually appears | Browser install-prompt UI isn't exposed to Playwright's automation API in a testable way, and item 3 above means it currently can't fire regardless | Not verified — blocked on icons (Task 8 finding #4) |
| App launches full-screen from the home-screen icon (`manifest.json`'s `"display": "fullscreen"`) | Requires actually installing and launching from a home screen | Not verified |
| Touch target sizing feels right on real hardware (`.touch-target` CSS class used throughout `apps/web/components/pos/`) | Emulated viewports don't reproduce real touch ergonomics | Not verified |
| Service-worker update flow (new deploy → user gets prompted/refreshed cleanly) | Needs two real deploys in sequence to observe | Not verified |
| Battery/thermal behavior under sustained POS use on real low-end hardware | Not observable in emulation at all | Not verified |
| Reconnect-sync doesn't get interrupted by `next-pwa`'s `reloadOnOnline: true` | Flagged as a real timing risk in Task 8 finding #5 — needs to be watched for specifically during real-device offline testing, not assumed either way | Not verified |

## Next step

Whoever runs this against a real production build should: fill in the Pass/Fail column above, attempt the manual items with actual (or emulated via Chrome DevTools' device toolbar, as a fallback) low-end hardware, and specifically watch for the reconnect-sync race from Task 8 finding #5 while doing the offline-shell-load and manual reconnect checks together.
