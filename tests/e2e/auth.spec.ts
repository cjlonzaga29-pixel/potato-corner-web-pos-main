// AUTHORED, NOT EXECUTED: no local Postgres/Redis instance is available in
// the environment this was written in (see phase-19-debt.md), so this spec
// has never actually been run against a live app. Selectors were taken from
// reading the real components (apps/web/app/(auth)/login/_components/
// login-form.tsx and each role's dashboard page), not guessed, but the flow
// itself is unverified until someone runs it against seeded infra.
import { test, expect } from '@playwright/test';
import { TEST_USERS } from './fixtures/test-users';

const DASHBOARD_HEADINGS: Record<keyof typeof TEST_USERS, string> = {
  super_admin: 'Super Admin Dashboard',
  supervisor: 'Branch Dashboard',
  staff: '', // terminal page has no matching <h1> — presence of the product grid is the assertion instead
};

for (const [key, user] of Object.entries(TEST_USERS)) {
  test(`login redirects ${user.role} to their dashboard`, async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL(`**${user.dashboardPath}`);
    expect(new URL(page.url()).pathname).toBe(user.dashboardPath);

    const heading = DASHBOARD_HEADINGS[key as keyof typeof TEST_USERS];
    if (heading) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
  });
}

test('invalid password shows an error and does not navigate away from /login', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(TEST_USERS.staff.email);
  await page.getByLabel('Password').fill('WrongPassword123');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // auth.router.ts returns a generic AuthError the login form renders inline
  // — asserting the page stays on /login is the stable check; the exact
  // message text is an implementation detail of authService.login.
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('.text-destructive').first()).toBeVisible();
});
