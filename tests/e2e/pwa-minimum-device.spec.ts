// AUTHORED, NOT EXECUTED: no local Postgres/Redis instance is available in
// the environment this was written in (see phase-19-debt.md) — never run
// against a live app.
//
// Phase 19 Task 9 — minimum-device PWA testing checklist. Locked device
// profile: Android-class, ~2GB RAM, 4-core CPU, Chrome stable, Playwright
// emulation baseline (real-device verification optional, not required to
// pass this file). Runs under the "PWA Minimum-Device (Android)" Playwright
// project (playwright.config.ts), which emulates Moto G4 — a 2016 budget
// Android device (quad-core Snapdragon 617, 2GB RAM) that's Playwright's
// closest built-in match to the locked profile, not an arbitrary pick.
//
// CRITICAL PRECONDITION, not a script bug: next.config.ts sets
// `disable: process.env.NODE_ENV === 'development'` on the @ducanh2912/
// next-pwa plugin — the service worker DOES NOT REGISTER AT ALL under
// `next dev`. Every service-worker-dependent check below (offline shell
// load, SW registration) will fail against a dev server for that reason
// alone, not because of an actual PWA defect. This suite must run against
// a production build (`next build && next start`), never `next dev`.
import { test, expect } from '@playwright/test';

test.describe('PWA minimum-device checklist', () => {
  test('manifest.json is reachable and well-formed', async ({ page, baseURL }) => {
    const res = await page.request.get(`${baseURL}/manifest.json`);
    expect(res.status()).toBe(200);
    const manifest = await res.json();
    expect(manifest.name).toBe('Potato Corner POS');
    expect(manifest.start_url).toBe('/terminal');
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  test('manifest is actually linked from the page — required for the install prompt to ever appear', async ({ page }) => {
    await page.goto('/login');
    const manifestLink = page.locator('link[rel="manifest"]');
    await expect(manifestLink).toHaveAttribute('href', '/manifest.json');
  });

  // Phase 20 Task 6: real branded PNGs were added to public/icons/
  // (previously only a README) — the test.fail() annotation that expected
  // this to fail (Phase 19 Task 8 finding #4) has been removed accordingly.
  test('PWA icons referenced by the manifest actually exist', async ({ page, baseURL }) => {
    const res192 = await page.request.get(`${baseURL}/icons/icon-192x192.png`);
    const res512 = await page.request.get(`${baseURL}/icons/icon-512x512.png`);
    expect(res192.status()).toBe(200);
    expect(res512.status()).toBe(200);
  });

  test('service worker registers on a production build', async ({ page }) => {
    await page.goto('/login');
    const hasServiceWorker = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registrations = await navigator.serviceWorker.getRegistrations();
      return registrations.length > 0;
    });
    expect(hasServiceWorker).toBe(true);
  });

  test('offline shell load — a previously-visited page still renders after going offline', async ({ page, context }) => {
    // Visit once online so next-pwa's runtime caching (cacheOnFrontEndNav +
    // aggressiveFrontEndNavCaching, next.config.ts) has something to serve
    // from cache.
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await context.setOffline(true);
    await page.reload();

    // A real offline failure renders the browser's own "no internet" error
    // page, not this app's markup — checking for the actual login form
    // (not just "the page didn't crash") is the meaningful assertion here.
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 10_000 });

    await context.setOffline(false);
  });

  test('key interaction stays responsive under simulated low-end CPU', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CPU throttling via CDP is Chromium-only');

    const client = await page.context().newCDPSession(page);
    // Simulates ~4x slower CPU than the machine actually running this test —
    // a rough proxy for a budget quad-core device, not a calibrated number
    // against real Moto-G4-class silicon. Treat this as directional, not a
    // precise hardware benchmark.
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    const start = Date.now();
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    const elapsedMs = Date.now() - start;

    // No hard pass/fail threshold from the architecture docs for this —
    // master-execution-plan.md's Monitoring section only specifies API
    // latency thresholds (2s general, 500ms transaction), not frontend
    // paint/interactive time under throttling. Logged for a human to read
    // and judge rather than asserted against a number nobody signed off on.
    console.log(`Login page interactive in ${elapsedMs}ms under 4x CPU throttling`);

    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });
});
