import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import path from 'path';

loadEnv({ path: path.resolve(__dirname, '.env.e2e') });

// Dedicated config for p3-fixes-verification.spec.ts. No globalSetup: the
// shared playwright.config.ts's global-setup.ts logs in with seeded test
// accounts that don't exist against the production pilot deployment. This
// targets the live pilot super admin via env vars instead (see
// .env.e2e.example) — same pattern as playwright.pilot.config.ts.
export default defineConfig({
  testDir: '.',
  testMatch: /p3-fixes-verification\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://potatorenovare.com',
    // No artifact capture: this suite runs against live pilot credentials, and
    // trace/screenshot/video all capture DOM state (including input values).
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    ...devices['Desktop Chrome'],
  },
});
