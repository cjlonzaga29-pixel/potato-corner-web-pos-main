// Production E2E suite for the expenses admin UI (apps/web/app/(admin)/admin/expenses).
// Every test that creates data cleans it up via API DELETE in a finally block.
// Uses a single shared session (see helpers/prod-login.ts) to stay well under
// loginLimiter's 10 logins/15min-per-IP cap — do not add additional
// page.goto('/login') calls to this file.
import path from 'node:path';
import { expect, type APIRequestContext } from '@playwright/test';
import { test, createAuthedApiContext, authedDelete } from './helpers/prod-login';
import { authedPost } from './fixtures/api-helpers';

interface ExpenseRecord {
  id: string;
  branch_id: string;
  category: string;
  amount: number;
  vendor_name: string | null;
}

interface BranchesResponse {
  branches: { id: string; name: string; code: string }[];
}

let apiRequest: APIRequestContext;
let accessToken: string;
let firstBranchId: string;
const baseURL = 'https://www.potatorenovare.com';

test.beforeAll(async () => {
  const ctx = await createAuthedApiContext(baseURL);
  apiRequest = ctx.request;
  accessToken = ctx.accessToken;

  const res = await apiRequest.get('/api/branches?status=active&limit=1', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await res.json()) as { data: BranchesResponse | null };
  if (!body.data?.branches?.[0]) throw new Error('No active branch found to use as the test fixture branch');
  firstBranchId = body.data.branches[0].id;
});

test.afterAll(async () => {
  await apiRequest.dispose();
});

async function createFixtureExpense(overrides: {
  category: string;
  vendor_name: string;
  amount: number;
}): Promise<string> {
  const result = await authedPost<ExpenseRecord>(apiRequest, baseURL, '/api/expenses', accessToken, {
    branch_id: firstBranchId,
    category: overrides.category,
    amount: overrides.amount,
    vendor_name: overrides.vendor_name,
    description: 'e2e fixture',
    incurred_at: new Date().toISOString(),
  });
  if (!result.data?.id) throw new Error(`Failed to create fixture expense: ${JSON.stringify(result.error)}`);
  return result.data.id;
}

async function deleteExpense(id: string): Promise<void> {
  await authedDelete(apiRequest, baseURL, `/api/expenses/${id}`, accessToken);
}

test('list page renders', async ({ page }) => {
  await page.goto('/admin/expenses');
  await expect(page.getByRole('heading', { name: 'Expenses' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Expenses' })).toHaveClass(/bg-primary/);
});

test('create expense end-to-end with cleanup', async ({ page }) => {
  let expenseId: string | undefined;
  try {
    await page.goto('/admin/expenses/new');

    await page.getByRole('combobox', { name: /branch/i }).click();
    await page.getByRole('option').first().click();

    await page.getByRole('combobox', { name: /category/i }).click();
    await page.getByRole('option', { name: 'Supplies' }).click();

    await page.getByLabel('Amount').fill('999');
    await page.getByLabel('Vendor Name').fill('PLAYWRIGHT-TEST-CREATE');
    await page.getByLabel('Description').fill('e2e create test');

    await page.getByRole('button', { name: 'Create Expense' }).click();

    await page.waitForURL(/\/admin\/expenses\/[0-9a-f-]{36}$/);
    expenseId = page.url().split('/').pop();

    await page.goto('/admin/expenses');
    await expect(page.getByRole('cell', { name: 'PLAYWRIGHT-TEST-CREATE' })).toBeVisible();
  } finally {
    if (expenseId) await deleteExpense(expenseId);
  }
});

test('filter by category narrows list', async ({ page }) => {
  const utilitiesId = await createFixtureExpense({
    category: 'utilities',
    vendor_name: 'PLAYWRIGHT-TEST-FILTER-U',
    amount: 100,
  });
  const suppliesId = await createFixtureExpense({
    category: 'supplies',
    vendor_name: 'PLAYWRIGHT-TEST-FILTER-S',
    amount: 200,
  });

  try {
    await page.goto('/admin/expenses');
    const categoryFilter = page.locator('#expense-category-filter');
    await categoryFilter.click();
    await page.getByRole('option', { name: 'Utilities' }).click();

    await expect(async () => {
      const rows = page.getByRole('row').filter({ hasText: 'PLAYWRIGHT-TEST-FILTER-' });
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        await expect(rows.nth(i)).toContainText('Utilities');
      }
    }).toPass({ timeout: 10_000 });
  } finally {
    await deleteExpense(utilitiesId);
    await deleteExpense(suppliesId);
  }
});

test('edit expense updates amount', async ({ page }) => {
  const expenseId = await createFixtureExpense({
    category: 'utilities',
    vendor_name: 'PLAYWRIGHT-TEST-EDIT',
    amount: 500,
  });

  try {
    await page.goto(`/admin/expenses/${expenseId}`);
    const amountInput = page.getByLabel('Amount');
    await amountInput.fill('');
    await amountInput.fill('1234');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByRole('button', { name: 'Save Changes' })).toBeEnabled();

    await page.goto('/admin/expenses');
    const row = page.getByRole('row').filter({ hasText: 'PLAYWRIGHT-TEST-EDIT' });
    await expect(row).toContainText(/1,234|1234/);
  } finally {
    await deleteExpense(expenseId);
  }
});

test('super admin can delete expense', async ({ page }) => {
  const expenseId = await createFixtureExpense({
    category: 'miscellaneous',
    vendor_name: 'PLAYWRIGHT-TEST-DELETE',
    amount: 50,
  });

  await page.goto(`/admin/expenses/${expenseId}`);
  await page.getByRole('button', { name: 'Delete Expense' }).click();
  await page.locator('#expense-delete-confirm').fill('DELETE');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  await page.waitForURL(/\/admin\/expenses$/);
  await expect(page.getByRole('cell', { name: 'PLAYWRIGHT-TEST-DELETE' })).toHaveCount(0);
});

test('CSV export downloads a file', async ({ page }) => {
  const expenseId = await createFixtureExpense({
    category: 'supplies',
    vendor_name: 'PLAYWRIGHT-TEST-CSV',
    amount: 150,
  });

  try {
    await page.goto('/admin/expenses');
    await expect(page.getByRole('cell', { name: 'PLAYWRIGHT-TEST-CSV' })).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  } finally {
    await deleteExpense(expenseId);
  }
});

test('receipt upload with real image', async ({ page }) => {
  const expenseId = await createFixtureExpense({
    category: 'supplies',
    vendor_name: 'PLAYWRIGHT-TEST-UPLOAD',
    amount: 75,
  });

  try {
    await page.goto(`/admin/expenses/${expenseId}`);
    const fixturePath = path.join(__dirname, 'fixtures', 'gcash-test.png');
    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await page.getByRole('button', { name: 'Upload' }).click();
    await expect(page.getByRole('img', { name: /receipt preview|receipt/i })).toBeVisible({ timeout: 10_000 });
  } finally {
    await deleteExpense(expenseId);
  }
});
