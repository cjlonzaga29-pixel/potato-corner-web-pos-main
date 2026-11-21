// POS-PERF-P62 — shared helpers for the local browser driver. LOCAL ONLY: the
// base URL must be this task's localhost stack (stack.sh). Seed accounts are the
// repo's non-secret test seeds (apps/api/prisma/seed.ts); PINs come from the
// stack's env file and are never printed.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const WEB = process.env.P62_WEB_URL || 'http://localhost:56433';
if (!/^http:\/\/localhost:\d+$/.test(WEB)) throw new Error('Refusing: P62_WEB_URL must be a localhost URL');
export const OUT = process.env.P62_OUT || 'C:/p62/out';
fs.mkdirSync(OUT, { recursive: true });

export const ACCOUNTS = {
  admin: { email: 'admin@potatocorner.test', password: 'SuperAdmin123', home: '/admin/dashboard' },
  supervisor: { email: 'supervisor@potatocorner.test', password: 'Supervisor123', home: '/supervisor/dashboard' },
  branch: { email: 'branch@potatocorner.test', password: 'BranchAccount123', home: '/branch/dashboard' },
};

const results = [];
export function record(step, ok, detail = {}) {
  // `ok` last: a detail object may carry its own `ok` (e.g. a URL check) and must not override the verdict.
  results.push({ step, ...detail, ok, at: new Date().toISOString() });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${Object.keys(detail).length ? ' ' + JSON.stringify(detail) : ''}`);
}
export function check(step, condition, detail) {
  record(step, Boolean(condition), detail);
  return Boolean(condition);
}
export function saveResults(name) {
  const file = path.join(OUT, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed -> ${file}`);
  return failed;
}

/** A persistent Chromium profile in a short path (long ones break CacheStorage on Windows). */
export async function openProfile(name, options = {}) {
  const dir = `C:/p62/prof-${name}`;
  const context = await chromium.launchPersistentContext(dir, {
    headless: process.env.P62_HEADED !== '1',
    viewport: { width: 1366, height: 900 },
    serviceWorkers: 'allow',
    permissions: ['geolocation'],
    geolocation: { latitude: 14.6, longitude: 121.0 },
    ...options,
  });
  return context;
}

export async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }).catch(() => {});
}

export async function dumpAria(page, name) {
  const snap = await page.locator('body').ariaSnapshot().catch((e) => `ERR ${e.message}`);
  fs.writeFileSync(path.join(OUT, `${name}.aria.txt`), snap);
  return snap;
}

export async function login(page, who) {
  const account = ACCOUNTS[who];
  await page.goto(`${WEB}/login`);
  await page.waitForLoadState('domcontentloaded');
  // A persistent profile may still hold this account's session: /login then redirects home.
  if (new URL(page.url()).pathname.startsWith(account.home)) return;
  await page.getByLabel('Email').fill(account.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`**${account.home}`, { timeout: 60_000 });
}

/** Waits until a service worker controls the page. */
export async function waitForController(page, timeout = 60_000) {
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout });
  return page.evaluate(() => navigator.serviceWorker.controller.scriptURL);
}

/** Every cached request URL, by cache name. */
export function cacheInventory(page) {
  return page.evaluate(async () => {
    const out = {};
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      out[name] = (await cache.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
    }
    return out;
  });
}

export function apiEntries(inventory) {
  return Object.entries(inventory).flatMap(([name, urls]) => urls.filter((u) => u.startsWith('/api/')).map((u) => `${name}:${u}`));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
