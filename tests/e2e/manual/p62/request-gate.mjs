// POS-PERF-P62 — counts the API requests a page sends before its session is
// restored, observed in a real browser on the LOCAL stack (stack.sh).
//
//   node tests/e2e/manual/p62/request-gate.mjs <label> [rounds=3]
//
// For Admin, Supervisor, Branch account and a staff account signed in directly:
// sign in on a fresh profile, then per round a hard reload of the home page and a
// client-side navigation (sidebar link) to Reports and back. Every /api/ request
// is read from the browser itself (headers as sent, status as received):
//   unauthenticated — a protected request sent with no Authorization header
//   status401       — any protected request answered 401
//   noBranch        — a branch-scoped report requested without branch_id
//   badRequest      — any 400
// Public endpoints (login, refresh, reset, receipt lookup) are listed separately.
// Paced so no per-user or per-IP budget is reached. Results: OUT/request-gate-<label>.json
import fs from 'node:fs';
import { WEB, OUT, ROOT, ACCOUNTS, openProfile, login, sleep } from './lib.mjs';

const LABEL = process.argv[2] ?? 'run';
const ROUNDS = Number(process.argv[3] ?? 3);
const PACE_MS = Number(process.env.P62_PACE_MS || 6000);

const ROLES = {
  admin: { ...ACCOUNTS.admin, reports: '/admin/reports' },
  supervisor: { ...ACCOUNTS.supervisor, reports: '/supervisor/reports' },
  branch: { ...ACCOUNTS.branch, reports: '/branch/sales' },
  staff: { email: 'staff@potatocorner.test', password: 'Staff123', home: null, reports: '/branch/sales' },
};

const PUBLIC = [/^\/api\/auth\/(login|refresh|request-reset|reset-password|2fa\/verify-login|2fa\/verify-backup-code|pin\/login)$/, /^\/api\/receipts\//, /^\/api\/health/];
const BRANCH_SCOPED = /^\/api\/reports\/(daily-sales|shift-summary|cash-reconciliation)/;

function watch(page) {
  const seen = [];
  const t0 = Date.now();
  const onRequest = async (req) => {
    const u = new URL(req.url());
    if (!u.pathname.startsWith('/api/')) return;
    // Recorded before any await, so its response can never arrive first.
    const entry = { req, path: u.pathname, query: u.search, method: req.method(), start: Date.now() - t0, auth: Boolean(req.headers().authorization) };
    seen.push(entry);
    const headers = await req.allHeaders().catch(() => null);
    if (headers) entry.auth = Boolean(headers.authorization);
  };
  const onFailed = (req) => {
    const entry = seen.find((r) => r.req === req);
    if (entry) { entry.status = `failed:${req.failure()?.errorText ?? '?'}`; entry.end = Date.now() - t0; }
  };
  const onResponse = (res) => {
    const entry = seen.find((r) => r.req === res.request());
    if (entry) { entry.status = res.status(); entry.end = Date.now() - t0; }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  return {
    stop() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onFailed);
      const rows = seen.map(({ req, ...rest }) => rest);
      const isPublic = (r) => PUBLIC.some((re) => re.test(r.path));
      const prot = rows.filter((r) => !isPublic(r));
      return {
        total: rows.length,
        publicCalls: rows.filter(isPublic).map((r) => `${r.method} ${r.path} ${r.status ?? '-'}`),
        protectedCalls: prot.length,
        unauthenticated: prot.filter((r) => !r.auth).length,
        status401: prot.filter((r) => r.status === 401).length,
        badRequest: rows.filter((r) => r.status === 400).length,
        noBranch: prot.filter((r) => BRANCH_SCOPED.test(r.path) && !new URLSearchParams(r.query).get('branch_id')).length,
        aborted: prot.filter((r) => typeof r.status === 'string').map((r) => `${r.method} ${r.path} auth=${r.auth} ${r.status}`),
        otherNon2xx: prot.filter((r) => typeof r.status === 'number' && (r.status < 200 || r.status >= 300) && r.status !== 401 && r.status !== 400).map((r) => `${r.method} ${r.path} ${r.status}`),
        unanswered: prot.filter((r) => !r.status).length,
        timeline: rows.map((r) => `${r.start}ms ${r.method} ${r.path}${r.query.length > 60 ? r.query.slice(0, 60) + '...' : r.query} auth=${r.auth} ${r.status ?? '-'}`),
        offenders: prot.filter((r) => !r.auth || r.status === 401 || r.status === 400).map((r) => `${r.start}ms ${r.method} ${r.path}${r.query} auth=${r.auth} ${r.status ?? '-'}`),
      };
    },
  };
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  await page.locator('main h1, main h2').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  await sleep(1500);
}

async function signIn(page, role) {
  const a = ROLES[role];
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill(a.email);
  await page.getByRole('textbox', { name: 'Password' }).fill(a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
  await settle(page);
  return new URL(page.url()).pathname;
}

const results = [];
const ONLY = process.env.P62_ROLES ? process.env.P62_ROLES.split(',') : Object.keys(ROLES);
for (const role of ONLY) {
  const name = `gate-${LABEL}-${role}`;
  fs.rmSync(`${ROOT}/prof-${name}`, { recursive: true, force: true });
  const context = await openProfile(name);
  const page = context.pages()[0] ?? (await context.newPage());
  const w0 = watch(page);
  const home = await signIn(page, role);
  results.push({ role, round: 0, kind: 'sign-in', home, ...w0.stop() });
  // The earlier perf-nav "cold" sequence: sign in, then load home again at once,
  // while the post-sign-in page is still sending its own (authenticated) requests.
  await context.clearCookies();
  await sleep(PACE_MS);
  {
    const a = ROLES[role];
    await page.goto(`${WEB}/login`);
    await page.getByLabel('Email').fill(a.email);
    await page.getByRole('textbox', { name: 'Password' }).fill(a.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
    await page.waitForRequest((r) => new URL(r.url()).pathname.startsWith('/api/') && !new URL(r.url()).pathname.startsWith('/api/auth/'), { timeout: 30_000 }).catch(() => {});
    const wi = watch(page);
    await page.goto(`${WEB}${home}`, { waitUntil: 'commit' });
    await settle(page);
    results.push({ role, round: 0, kind: 'reload-during-post-sign-in-load', home, signedIn: !new URL(page.url()).pathname.startsWith('/login'), ...wi.stop() });
  }
  for (let round = 1; round <= ROUNDS; round += 1) {
    await sleep(PACE_MS);
    const w1 = watch(page);
    await page.goto(`${WEB}${home}`, { waitUntil: 'commit' });
    await settle(page);
    const signedIn = !new URL(page.url()).pathname.startsWith('/login');
    results.push({ role, round, kind: 'hard-reload', home, signedIn, ...w1.stop() });

    await sleep(PACE_MS);
    const target = ROLES[role].reports;
    const link = page.locator(`a[href="${target}"]`).first();
    if (await link.count()) {
      const w2 = watch(page);
      await link.click();
      await page.waitForURL(`**${target}`, { timeout: 30_000 }).catch(() => {});
      await settle(page);
      const back = page.locator(`a[href="${home}"]`).first();
      if (await back.count()) { await back.click(); await page.waitForURL(`**${home}`, { timeout: 30_000 }).catch(() => {}); await settle(page); }
      results.push({ role, round, kind: 'client-nav', path: `${home} -> ${target} -> ${home}`, ...w2.stop() });
    } else {
      results.push({ role, round, kind: 'client-nav', path: `${target} link not in sidebar`, skipped: true });
    }
  }
  await context.close();
}

fs.writeFileSync(`${OUT}/request-gate-${LABEL}.json`, JSON.stringify(results, null, 2));
const rows = results.map((r) => ({ role: r.role, round: r.round, kind: r.kind, total: r.total, protected: r.protectedCalls, noAuth: r.unauthenticated, s401: r.status401, s400: r.badRequest, noBranch: r.noBranch, other: r.otherNon2xx?.length ?? 0, aborted: r.aborted?.length ?? 0, unanswered: r.unanswered, signedIn: r.signedIn }));
console.table(rows);
