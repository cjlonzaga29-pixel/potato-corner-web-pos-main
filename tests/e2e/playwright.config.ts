import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  globalSetup: require.resolve('./global-setup.ts'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['html'], ['github']],
  use: {
    // Staging/live runs must set PLAYWRIGHT_BASE_URL explicitly; local dev falls back to localhost.
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'POS Terminal (Mobile)',
      testIgnore: /pwa-minimum-device\.spec\.ts/,
      use: { ...devices['Galaxy Tab S4'] },
    },
    {
      name: 'Admin Dashboard (Desktop)',
      testIgnore: /pwa-minimum-device\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Phase 19 Task 9 locked device profile: Android-class, ~2GB RAM,
      // 4-core CPU, Chrome stable. Moto G4 (2016 budget Android — quad-core
      // Snapdragon 617, 2GB RAM) is Playwright's closest built-in match to
      // that spec, not an arbitrary pick. Scoped to pwa-minimum-device.spec.ts
      // only via testMatch — running the whole suite a third time under a
      // throttled device profile would be expensive for no benefit, since
      // every other spec's assertions aren't device-profile-specific.
      name: 'PWA Minimum-Device (Android)',
      testMatch: /pwa-minimum-device\.spec\.ts/,
      use: { ...devices['Moto G4'] },
    },
  ],
});
