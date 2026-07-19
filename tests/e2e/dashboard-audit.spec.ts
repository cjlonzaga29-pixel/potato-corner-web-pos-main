import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

const ADMIN_PAGES = [
  '/admin/dashboard', '/admin/branches', '/admin/products', '/admin/flavors',
  '/admin/recipes', '/admin/shifts', '/admin/approvals/product-requests',
  '/admin/approvals/price-overrides', '/admin/employees', '/admin/reports',
  '/admin/fraud-alerts', '/admin/audit-logs', '/admin/settings', '/admin/attendance',
];
const SUPERVISOR_PAGES = [
  '/supervisor/dashboard', '/supervisor/inventory', '/supervisor/attendance',
  '/supervisor/cash', '/supervisor/employees', '/supervisor/reports',
  '/supervisor/product-requests', '/supervisor/price-overrides', '/supervisor/recipes',
];
const STAFF_PAGES = ['/terminal', '/shift', '/receipts'];

async function auditPage(page: Page, url: string, dir: string) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch((e) => {
    errors.push(`nav-fail: ${e}`);
    return null;
  });
  await page.waitForTimeout(500);

  const brokenImgs = await page.$$eval('img', (imgs) =>
    imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src)
  );
  const mainText = await page.evaluate(() => document.querySelector('main')?.textContent?.trim().length ?? 0);

  const fname = url.replace(/\//g, '_') || '_root';
  await page.screenshot({ path: path.join(dir, `${fname}.png`), fullPage: true });

  return {
    url,
    status: resp?.status() ?? 'nav-error',
    consoleErrors: errors.slice(0, 5),
    brokenImages: brokenImgs,
    mainContentLength: mainText,
  };
}

test.describe('Admin dashboard audit', () => {
  test.use({ storageState: 'tests/e2e/fixtures/super_admin.auth.json' });

  test('sweep all admin pages', async ({ page }) => {
    const dir = 'tests/e2e/screenshots/admin';
    const results = [];
    for (const url of ADMIN_PAGES) {
      results.push(await auditPage(page, url, dir));
    }
    console.log('ADMIN_AUDIT_RESULTS', JSON.stringify(results, null, 2));
  });
});

test.describe('Supervisor dashboard audit', () => {
  test.use({ storageState: 'tests/e2e/fixtures/supervisor.auth.json' });

  test('sweep all supervisor pages', async ({ page }) => {
    const dir = 'tests/e2e/screenshots/supervisor';
    const results = [];
    for (const url of SUPERVISOR_PAGES) {
      results.push(await auditPage(page, url, dir));
    }
    console.log('SUPERVISOR_AUDIT_RESULTS', JSON.stringify(results, null, 2));
  });
});

test.describe('Staff dashboard audit', () => {
  test.use({ storageState: 'tests/e2e/fixtures/staff.auth.json' });

  test('sweep all staff pages', async ({ page }) => {
    const dir = 'tests/e2e/screenshots/staff';
    const results = [];
    for (const url of STAFF_PAGES) {
      results.push(await auditPage(page, url, dir));
    }
    console.log('STAFF_AUDIT_RESULTS', JSON.stringify(results, null, 2));
  });
});

test.describe('Responsive audit', () => {
  test.use({ storageState: 'tests/e2e/fixtures/super_admin.auth.json' });
  const viewports = [
    { name: 'desktop', width: 1920, height: 1080 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 375, height: 667 },
  ];
  const pages = ['/admin/dashboard', '/admin/products'];

  for (const vp of viewports) {
    test(`responsive @ ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const url of pages) {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        await page.screenshot({
          path: `tests/e2e/screenshots/responsive/${vp.name}${url.replace(/\//g, '_')}.png`,
          fullPage: true,
        });
      }
    });
  }
});
