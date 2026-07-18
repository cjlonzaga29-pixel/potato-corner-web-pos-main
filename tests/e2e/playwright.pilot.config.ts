import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import path from 'path';

loadEnv({ path: path.resolve(__dirname, '.env.e2e') });

// Dedicated config for the Phase 20 pilot smoke suite (pilot-smoke.spec.ts).
// Deliberately has NO globalSetup: the shared playwright.config.ts's
// global-setup.ts logs in with hardcoded seeded test accounts
// (fixtures/test-users.ts) that don't exist against the production pilot
// deployment. This config targets live pilot users via env vars instead
// (see .env.e2e.example) and must never be pointed at a non-production
// PLAYWRIGHT_BASE_URL that also lacks those accounts.
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
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://potatorenovare.com',
    // No artifact capture: this suite runs against live pilot credentials, and
    // trace/screenshot/video all capture DOM state (including input values). If
    // a test fails, re-run with tracing enabled locally against a throwaway
    // account instead of against pilot credentials.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'Pilot Smoke (Desktop Chrome)',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
