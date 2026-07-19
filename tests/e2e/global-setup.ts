import path from 'node:path';
import { chromium, type FullConfig } from '@playwright/test';
import { TEST_USERS, type TestUserKey } from './fixtures/test-users';

/**
 * Logs in as each seeded role through the real login form (not a raw API
 * call) and saves the resulting storage state — the refresh_token cookie
 * this sets is what apps/web/hooks/use-auth.ts's silent-refresh-on-mount
 * relies on, so a saved storageState is enough to restore a logged-in
 * session on a fresh page load without re-submitting the form every test.
 * Written to tests/e2e/fixtures/{role}.auth.json, matching the location
 * fixtures/README.md already documented as the intended convention.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:3000';
  const browser = await chromium.launch();

  for (const key of Object.keys(TEST_USERS) as TestUserKey[]) {
    const user = TEST_USERS[key];
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();

    await page.goto('/login');
    await page.getByLabel('Email').fill(user.email);
    await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(`**${user.dashboardPath}`);

    await context.storageState({ path: path.join(__dirname, 'fixtures', `${key}.auth.json`) });
    await context.close();
  }

  await browser.close();
}
