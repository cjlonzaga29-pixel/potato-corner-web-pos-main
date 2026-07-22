// Production E2E suite for the /notifications full-page inbox
// (apps/web/app/notifications). Uses the shared prod-login session — no
// additional page.goto('/login') calls, no seeding/cleanup needed since
// this reads whatever notifications already exist for the session account.
//
// Scope note: this page ships with only what use-notifications.ts /
// GET /api/notifications currently support (a single page=1&limit=25 list,
// mark-read, mark-all-read) — no type filter, no unread filter, no
// pagination controls, since neither the hook nor the backend query
// schema expose those params yet.
import { test } from './helpers/prod-login';
import { expect } from '@playwright/test';

test('notifications page renders title and list or empty state', async ({ page }) => {
  await page.goto('/notifications');
  // Wait for auth to hydrate + query to settle
  await page.waitForLoadState('networkidle', { timeout: 15000 });
  await page.waitForTimeout(2000); // safety buffer for enabled gate to fire
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();

  const emptyState = page.getByText('No notifications');
  const listRows = page.locator('button', { hasText: /ago$/ });
  await expect(emptyState.or(listRows.first())).toBeVisible({ timeout: 15000 });
});

test('"Mark all as read" is disabled with 0 unread notifications', async ({ page }) => {
  await page.goto('/notifications');
  const markAllButton = page.getByRole('button', { name: /Mark all as read/ });
  await expect(markAllButton).toBeVisible();

  const unreadBadge = page.locator('h1 + span');
  if ((await unreadBadge.count()) === 0) {
    await expect(markAllButton).toBeDisabled();
  }
});
