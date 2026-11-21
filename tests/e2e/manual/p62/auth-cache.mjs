// POS-PERF-P62 — real-browser auth and service-worker cache checks against the
// LOCAL stack (stack.sh), production builds, service worker active.
//
//   node tests/e2e/manual/p62/auth-cache.mjs old   # web built with fa31ede's next.config.ts
//   node tests/e2e/manual/p62/auth-cache.mjs new   # same origin and profile, current build
//   node tests/e2e/manual/p62/auth-cache.mjs session
//
// "old" populates the previous build's `apis` cache and shows the risk it posed;
// "new" upgrades that same profile and checks the cache is gone and unused.
// Network failures are injected in the browser (page.route), never by changing
// the API; rate limits are respected (the driver paces itself).
import fs from 'node:fs';
import path from 'node:path';
import { WEB, OUT, openProfile, login, waitForController, cacheInventory, apiEntries, check, record, saveResults, shot, sleep } from './lib.mjs';

const phase = process.argv[2];
const PROFILE = 'upgrade';
const PAGES = ['/supervisor/dashboard', '/supervisor/products', '/supervisor/inventory', '/supervisor/reports', '/supervisor/expenses'];

async function browse(page) {
  for (const p of PAGES) {
    await page.goto(`${WEB}${p}`);
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    await sleep(1500);
  }
}

async function offlineFetch(context, page, url) {
  await context.setOffline(true);
  const result = await page.evaluate(async (u) => {
    try {
      const res = await fetch(u);
      return { status: res.status, body: (await res.text()).slice(0, 120) };
    } catch (e) {
      return { error: String(e) };
    }
  }, url);
  await context.setOffline(false);
  return result;
}

async function signedIn(page, home) {
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  await sleep(1000);
  const url = new URL(page.url()).pathname;
  return { url, ok: url.startsWith(home) && !url.startsWith('/login') };
}

async function logoutViaMenu(page) {
  const menu = page.getByRole('button', { name: 'Account menu' });
  const item = page.getByRole('menuitem', { name: 'Log out' });
  await menu.waitFor({ state: 'visible', timeout: 30_000 });
  // A re-render while the page is still loading can close the menu; open it again.
  for (let attempt = 0; attempt < 4 && !(await item.isVisible()); attempt += 1) {
    await menu.click();
    await item.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  }
  await item.click();
  await page.waitForURL('**/login', { timeout: 30_000 });
}

async function runOld() {
  const context = await openProfile(PROFILE);
  const page = context.pages()[0] ?? (await context.newPage());
  await login(page, 'supervisor');
  const sw = await waitForController(page).catch(() => null);
  check('old: a service worker controls the page', sw, { sw });
  await browse(page);
  const inv = await cacheInventory(page);
  const cached = apiEntries(inv);
  check('old: the previous build stores authenticated API responses', cached.length > 0, { count: cached.length, sample: cached.slice(0, 4) });
  fs.writeFileSync(path.join(OUT, 'old-api-cache.json'), JSON.stringify(cached, null, 2));
  const target = cached.map((e) => e.slice(e.indexOf(':') + 1)).find((u) => !u.startsWith('/api/auth')) ?? '/api/auth/me';
  // Offline, with no Authorization header at all: the old SW answers from its cache.
  const offline = await offlineFetch(context, page, target);
  check('old: offline, an unauthenticated fetch is answered from the API cache (the risk)', offline.status === 200, { target, status: offline.status ?? offline.error });
  await context.close(); // no logout: the cache stays as a real user would leave it
  return saveResults('auth-cache-old');
}

async function runNew() {
  const before = JSON.parse(fs.readFileSync(path.join(OUT, 'old-api-cache.json'), 'utf8'));
  const context = await openProfile(PROFILE);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.addInitScript(() => {
    window.__p62ControllerChanges = 0;
    navigator.serviceWorker?.addEventListener('controllerchange', () => { window.__p62ControllerChanges += 1; });
  });
  // Hold the update check so the old worker keeps control while the dashboard loads
  // its API data: the window in which it can still write to `apis`.
  const holdMs = Number(process.env.P62_SW_HOLD_MS || 8000);
  await context.route('**/sw.js', async (route) => { await sleep(holdMs); await route.continue(); });
  const t0 = Date.now();
  await page.goto(`${WEB}/supervisor/dashboard`);
  await waitForController(page);
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  const writtenByOld = apiEntries(await cacheInventory(page)).length;
  check('new: while the old worker still controls the page it stores API responses (window exercised)', writtenByOld > 0, { writtenByOld, holdMs });
  await context.unroute('**/sw.js');
  // `waiting == null` is also true while installing, so wait for the new worker to be
  // installed, activated and in control: no installing/waiting and a controllerchange seen.
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg && !reg.installing && !reg.waiting && reg.active?.state === 'activated' && window.__p62ControllerChanges > 0;
  }, null, { timeout: 180_000, polling: 500 });
  const takeoverMs = Date.now() - t0;
  const duringTakeover = apiEntries(await cacheInventory(page)).length;
  await sleep(7000); // past the 5s second purge
  const afterTakeover = apiEntries(await cacheInventory(page));
  check('new: after the new worker takes control, no API response remains (no reload)', afterTakeover.length === 0, { takeoverMs, entriesWhileOldWorkerControlled: duringTakeover, left: afterTakeover.slice(0, 4) });
  await page.reload();
  const session = await signedIn(page, '/supervisor');
  check('new: the session survives the upgrade', session.ok, session);
  const swText = await page.evaluate(async () => (await fetch('/sw.js', { cache: 'no-store' })).text());
  check('new: the active sw.js routes /api/ NetworkOnly', /NetworkOnly/.test(swText) && /startsWith\("\/api\/"\)/.test(swText), {});
  const inv = await cacheInventory(page);
  check('new: the old apis cache is gone', !('apis' in inv), { caches: Object.keys(inv) });
  check('new: no cache holds an /api/ response', apiEntries(inv).length === 0, { left: apiEntries(inv).slice(0, 4), before: before.length });
  await browse(page);
  const after = apiEntries(await cacheInventory(page));
  check('new: browsing every Supervisor page stores no API response', after.length === 0, { left: after.slice(0, 4) });
  const target = before.map((e) => e.slice(e.indexOf(':') + 1)).find((u) => !u.startsWith('/api/auth')) ?? '/api/auth/me';
  const offline = await offlineFetch(context, page, target);
  check('new: offline, the same request is not answered from any cache', offline.status !== 200, { target, result: offline.status ?? offline.error });
  await context.close();
  return saveResults('auth-cache-new');
}

/** Marks a response this driver fabricated, so it is never counted as the application's. */
const INJECTED_HEADER = 'x-p62-injected';
const injectedAborts = new WeakSet();
const tally = (xs) => xs.reduce((m, x) => { const k = x.replace(/^[^:]+:/, ''); m[k] = (m[k] ?? 0) + 1; return m; }, {});

async function runSession() {
  const context = await openProfile('session');
  const page = context.pages()[0] ?? (await context.newPage());
  // Three kinds of outcome are kept apart:
  //  injected   — failures this driver fabricates (page.route fulfil/abort), tagged at the source;
  //  unexpected — real API 429/5xx answers and page errors: application failures;
  //  recovery   — what the user is expected to see afterwards (the checks below).
  // Rate limits are respected, not bypassed: pause between phases.
  const injected = [];
  const unexpected = [];
  let phase = 'start';
  context.on('response', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/')) return;
    if (r.headers()[INJECTED_HEADER]) { injected.push(`${phase}:${r.status()} ${u.pathname}`); return; }
    if (r.status() === 429 || r.status() >= 500) unexpected.push(`${phase}:${r.status()} ${r.request().method()} ${u.pathname}`);
  });
  context.on('requestfailed', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/')) return;
    if (injectedAborts.has(r)) injected.push(`${phase}:aborted ${u.pathname}`);
  });
  page.on('pageerror', (e) => unexpected.push(`${phase}:pageerror ${String(e.message).slice(0, 120)}`));
  const pace = () => sleep(Number(process.env.P62_PACE_MS || 25000));
  await login(page, 'supervisor');
  await waitForController(page);

  // Slow refresh + reload, twice in the middle of the slow refresh.
  phase = 'slow-refresh';
  let slowRefreshes = 0;
  await page.route('**/api/auth/refresh', async (route) => { slowRefreshes += 1; await sleep(6000); await route.continue().catch(() => {}); }); // a reload cancels it
  await page.reload({ waitUntil: 'commit' });
  await sleep(2000);
  await page.reload({ waitUntil: 'commit' });
  await sleep(2000);
  await page.reload();
  await page.unroute('**/api/auth/refresh');
  let s = await signedIn(page, '/supervisor');
  check('session: reloads during a 6s refresh keep the user signed in', s.ok, { ...s, slowRefreshes });

  // Concurrent tabs reloading at once.
  phase = 'tabs';
  const tabs = [page, await context.newPage(), await context.newPage()];
  await Promise.all(tabs.slice(1).map((t) => t.goto(`${WEB}/supervisor/dashboard`)));
  await Promise.all(tabs.map((t) => t.reload()));
  const states = await Promise.all(tabs.map((t) => signedIn(t, '/supervisor')));
  await pace();
  check('session: three tabs reloading together all stay signed in', states.every((x) => x.ok), { states: states.map((x) => x.url) });
  for (const t of tabs.slice(1)) await t.close();

  // Transient refresh failures keep the session.
  phase = 'transient';
  for (const [label, handler] of [
    ['503', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } }), headers: { [INJECTED_HEADER]: '1' } })],
    ['429', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'RATE_LIMITED' } }), headers: { 'Retry-After': '1', [INJECTED_HEADER]: '1' } })],
    ['gateway HTML 502', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>', headers: { [INJECTED_HEADER]: '1' } })],
    ['network failure', (route) => { injectedAborts.add(route.request()); return route.abort('failed'); }],
  ]) {
    phase = `transient-${label}`;
    await page.route('**/api/auth/refresh', handler);
    await page.reload();
    const during = await signedIn(page, '/supervisor');
    await page.unroute('**/api/auth/refresh');
    await page.reload();
    const afterwards = await signedIn(page, '/supervisor');
    check(`session: a refresh ${label} does not sign the user out`, !during.url.startsWith('/login') && afterwards.ok, { during: during.url, after: afterwards.url });
    await pace();
  }

  // Logout, then replay the refresh cookie captured before it.
  phase = 'replay';
  const cookiesBefore = await context.cookies(WEB);
  await logoutViaMenu(page);
  await context.addCookies(cookiesBefore.map(({ name, value, domain, path: p, expires, httpOnly, secure, sameSite }) => ({ name, value, domain, path: p, expires, httpOnly, secure, sameSite })));
  const replayLog = [];
  const onReplay = async (r) => {
    if (!r.url().includes('/api/auth/refresh')) return;
    const h = await r.allHeaders().catch(() => ({}));
    replayLog.push(`${r.status()}${/refresh_token=;/.test(h['set-cookie'] || '') ? ' cleared' : ''}`);
  };
  page.on('response', onReplay);
  await page.goto(`${WEB}/supervisor/dashboard`);
  await page.waitForURL('**/login**', { timeout: 20_000 }).catch(() => {});
  s = await signedIn(page, '/supervisor');
  page.off('response', onReplay);
  const jar = (await context.cookies(WEB)).map((c) => c.name);
  check('session: the pre-logout refresh cookie, replayed, does not sign back in', !s.ok && !jar.includes('refresh_token'), { ...s, refreshes: replayLog, jar });

  await pace();
  // User A -> user B in the same browser: nothing of A's survives.
  phase = 'switch';
  await login(page, 'supervisor');
  await page.goto(`${WEB}/supervisor/reports`);
  let slowA = 0;
  // context.route: GETs go through the service worker, which page.route does not see.
  await context.route('**/api/**', async (route) => {
    if (route.request().method() === 'GET' && !route.request().url().includes('/api/auth/')) { slowA += 1; await sleep(5000); }
    await route.continue().catch(() => {});
  });
  await page.goto(`${WEB}/supervisor/dashboard`, { waitUntil: 'commit' });
  await sleep(500);
  await logoutViaMenu(page);
  const heldForA = slowA;
  await context.unroute('**/api/**');
  await login(page, 'admin');
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(6000); // past A's delayed responses
  const headerName = await page.getByRole('button', { name: 'Account menu' }).textContent().catch(() => '');
  const body = await page.locator('main').innerText().catch(() => '');
  const inv = apiEntries(await cacheInventory(page));
  check('switch: B lands on their own dashboard after A logged out mid-request', new URL(page.url()).pathname.startsWith('/admin') && heldForA > 0, { url: page.url(), heldForA });
  check('switch: no API response is cached for B to inherit', inv.length === 0, { left: inv.slice(0, 4) });
  record('switch: B header initials', true, { initials: headerName?.trim(), bodyChars: body.length });
  await shot(page, 'switch-admin');
  record('session: failures injected by this driver (not application failures)', true, { count: injected.length, byKind: tally(injected) });
  check('session: no unexpected application failure (no real API 429/5xx, no page error)', unexpected.length === 0, { count: unexpected.length, sample: unexpected.slice(0, 8) });
  await context.close();
  return saveResults('auth-session');
}

const run = { old: runOld, new: runNew, session: runSession }[phase];
if (!run) { console.error('usage: auth-cache.mjs old|new|session'); process.exit(2); }
const failed = await run();
process.exit(failed ? 1 : 0);
