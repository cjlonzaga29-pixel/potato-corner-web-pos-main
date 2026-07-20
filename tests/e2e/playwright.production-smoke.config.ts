import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import path from 'path';

loadEnv({ path: path.resolve(__dirname, '.env.e2e') });

// Dedicated config for production-smoke.spec.ts, mirroring
// playwright.pilot.config.ts: deliberately no globalSetup (the shared
// playwright.config.ts's global-setup.ts logs in with seeded test accounts
// from fixtures/test-users.ts that don't exist on production) and no
// trace/screenshot/video capture (those snapshot DOM state, including
// credential inputs, and this suite runs against live pilot credentials).
export default defineConfig({
  testDir: '.',
  testMatch: /production-smoke\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
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
