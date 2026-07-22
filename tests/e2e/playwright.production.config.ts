import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import path from 'path';

loadEnv({ path: path.resolve(__dirname, '.env.e2e') });

/**
 * Production config for expenses.production.spec.ts, branch-selector.production.spec.ts,
 * notifications-page.production.spec.ts, payments-gcash-qr.production.spec.ts,
 * monitoring-page.production.spec.ts, inventory-analytics-page.production.spec.ts,
 * and active-sessions.production.spec.ts.
 * Uses its own global-setup.production.ts (distinct from the shared
 * global-setup.ts, which logs in seeded local accounts that don't exist on
 * production) to perform ONE real login and save it as storageState.
 * Per-test session handling (reading + re-persisting the shared storageState
 * file around every test, since refresh tokens are single-use) happens in
 * helpers/prod-login.ts's custom `page` fixture — every spec file imports
 * `test` from there instead of '@playwright/test', so no `storageState` is
 * set here. trace/screenshot/video stay off: this runs against live
 * credentials, and DOM snapshots could capture the login form's password
 * input value.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /(expenses|branch-selector|notifications-page|payments-gcash-qr|monitoring-page|inventory-analytics-page|active-sessions)\.production\.spec\.ts/,
  globalSetup: require.resolve('./global-setup.production.ts'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // 1 retry to absorb transient production cold-start flakes (Vercel edge, Render DB reconnect)
  retries: 1,
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  preserveOutput: 'never',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://www.potatorenovare.com',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
