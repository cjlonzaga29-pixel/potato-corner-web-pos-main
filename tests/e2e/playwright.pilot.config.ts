import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import path from 'path';
import { resolveProductionSmokeBaseURL } from './helpers/e2e-target';

loadEnv({ path: path.resolve(__dirname, '.env.e2e') });

// Production-safe pilot smoke (pilot-smoke.spec.ts), run by
// deploy-production.yml after the web promote is verified (POS-PERF-P44).
// Deliberately has NO globalSetup: the shared playwright.config.ts's
// global-setup.ts logs in seeded local accounts and its suites seed and
// write business data. PLAYWRIGHT_BASE_URL has no default here — it must
// name an approved production origin, or a local one for rehearsal.
export default defineConfig({
  testDir: '.',
  testMatch: /pilot-smoke\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  preserveOutput: 'never',
  use: {
    baseURL: resolveProductionSmokeBaseURL(),
    // No artifact capture: this suite runs against live credentials, and
    // trace/screenshot/video all capture DOM state (including input values).
    // If a test fails, re-run it locally against disposable accounts.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    // A service worker's own fetches bypass page.route — blocking it keeps
    // every request under helpers/read-only-guard.ts.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'Pilot Smoke (Desktop Chrome)',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
