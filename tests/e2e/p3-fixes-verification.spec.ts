// Post-deploy verification for two P3 fixes against the live pilot deployment:
// CurrencyInput a11y attribute forwarding, and Socket.io CORS console silence.
// Credentials come from process.env only (see .env.e2e.example); this spec
// must never hardcode a password. Run via:
//   npx playwright test --config=playwright.p3-verify.config.ts
import { test, expect, type Page } from '@playwright/test';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} — copy .env.e2e.example to .env.e2e and fill it in`);
  }
  return value;
}

const SUPER_ADMIN = {
  email: requireEnv('E2E_SUPER_ADMIN_EMAIL'),
  password: requireEnv('E2E_SUPER_ADMIN_PASSWORD'),
};

// Wipes password field values immediately after submit — Playwright's
// error-context.md snapshot is captured at the moment of failure, before
// afterEach would ever run, so clearing must happen right after the click.
async function clearPasswordFields(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      document.querySelectorAll('input[type="password"]').forEach((el) => {
        (el as HTMLInputElement).value = '';
      });
    })
    .catch(() => {
      /* page may already be closed */
    });
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await clearPasswordFields(page);
  await page.waitForURL(/\/admin\/dashboard/);
}

test.describe('P3 Fixes Verification', () => {

  test('CurrencyInput forwards id and aria attributes', async ({ page }) => {
    await login(page, SUPER_ADMIN.email, SUPER_ADMIN.password);
    await page.goto('/admin/products');
    await page.locator('table tbody tr').first().click();
    await page.waitForURL(/\/admin\/products\//);
    // Base Price lives on the Variants & Flavors tab, not the top-level Edit Product dialog
    await page.getByRole('tab', { name: /variants & flavors/i }).click();
    const tabPanel = page.getByRole('tabpanel');
    const editVariantButton = tabPanel.getByRole('button', { name: /edit/i }).first();
    const addVariantButton = tabPanel.getByRole('button', { name: /add variant/i });
    if (await editVariantButton.isVisible().catch(() => false)) {
      await editVariantButton.click();
    } else {
      await addVariantButton.click();
    }
    await page.waitForSelector('[role="dialog"]');
    // Base Price CurrencyInput, located by its accessible label
    const priceInput = page.getByLabel(/base price/i);
    await expect(priceInput).toBeVisible();
    const id = await priceInput.getAttribute('id');
    const ariaLabel = await priceInput.getAttribute('aria-label');
    const ariaLabelledBy = await priceInput.getAttribute('aria-labelledby');
    const name = await priceInput.getAttribute('name');
    const hasAccessibleName = (id && id.length > 0) || (ariaLabel && ariaLabel.length > 0) || (ariaLabelledBy && ariaLabelledBy.length > 0);
    expect(hasAccessibleName, 'CurrencyInput must have id, aria-label, or aria-labelledby').toBeTruthy();
    expect(name || id, 'CurrencyInput must have name or id for form association').toBeTruthy();
  });

  test('Socket.io does not produce CORS console errors', async ({ page }) => {
    const corsErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (/CORS|Access-Control|socket\.io/i.test(text)) {
          corsErrors.push(text);
        }
      }
    });
    page.on('pageerror', err => {
      if (/CORS|Access-Control|socket\.io/i.test(err.message)) {
        corsErrors.push(err.message);
      }
    });
    await login(page, SUPER_ADMIN.email, SUPER_ADMIN.password);
    // Navigate to dashboard (heaviest socket.io usage)
    await page.goto('/admin/dashboard');
    await page.waitForTimeout(10000);
    if (corsErrors.length > 0) {
      console.log('CORS errors captured:', corsErrors);
    }
    expect(corsErrors, 'No Socket.io CORS errors should appear in console').toHaveLength(0);
  });

});
