// POS-PERF-P62 — navigation timing on the LOCAL stack (production builds, service
// worker active, p62 fixture data: 55,000 sales). LOCAL laptop timings, not hosted.
//
//   node tests/e2e/manual/p62/perf-nav.mjs [rounds=3]
//
// For each role and page: "cold" is the first visit in a fresh profile right after
// sign-in (empty HTTP cache; the service worker precache installs during it);
// "warm" is the same navigation repeated. Per visit:
//   firstDataMs  — navigation start until the first /api/ GET answers 2xx
//   usableMs     — until the network is idle and the page's main heading is visible
//   apiRequests  — /api/ requests the visit made; waterfall — each one's start/end/status
// Paced between visits so the per-user and per-IP budgets are never reached.
import fs from 'node:fs';
import { WEB, OUT, openProfile, login, sleep } from './lib.mjs';

const ROUNDS = Number(process.argv[2] ?? 3);
const PACE_MS = Number(process.env.P62_PACE_MS || 8000);
const PLAN = {
  admin: ['/admin/dashboard', '/admin/products', '/admin/inventory', '/admin/reports', '/admin/expenses'],
  supervisor: ['/supervisor/dashboard', '/supervisor/products', '/supervisor/inventory', '/supervisor/reports', '/supervisor/expenses'],
  branch: ['/branch/dashboard', '/branch/products', '/branch/inventory', '/branch/reports', '/branch/expenses'],
};

async function visit(page, path) {
  const requests = [];
  const t0 = Date.now();
  let firstData = null;
  const onRequest = (req) => { if (new URL(req.url()).pathname.startsWith('/api/')) requests.push({ req, start: Date.now() - t0 }); };
  const onResponse = (res) => {
    const u = new URL(res.url());
    if (!u.pathname.startsWith('/api/')) return;
    const entry = requests.find((r) => r.req === res.request());
    if (entry) { entry.end = Date.now() - t0; entry.status = res.status(); }
    if (firstData === null && res.request().method() === 'GET' && res.status() < 300 && !u.pathname.startsWith('/api/auth/')) firstData = Date.now() - t0;
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  await page.goto(`${WEB}${path}`, { waitUntil: 'commit' });
  await page.waitForLoadState('networkidle', { timeout: 90_000 }).catch(() => {});
  await page.locator('main h1, main h2').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  const usable = Date.now() - t0;
  page.off('request', onRequest);
  page.off('response', onResponse);
  const statuses = requests.map((r) => r.status ?? 0);
  return {
    firstDataMs: firstData,
    usableMs: usable,
    apiRequests: requests.length,
    non2xx: statuses.filter((s) => s < 200 || s >= 300).length,
    waterfall: requests.map((r) => ({ path: new URL(r.req.url()).pathname, start: r.start, end: r.end ?? null, status: r.status ?? null })),
  };
}

const results = [];
for (let round = 1; round <= ROUNDS; round += 1) {
  for (const [role, pages] of Object.entries(PLAN)) {
    const name = `nav-${role}-${round}`;
    fs.rmSync(`C:/p62/prof-${name}`, { recursive: true, force: true });
    const context = await openProfile(name);
    const page = context.pages()[0] ?? (await context.newPage());
    await login(page, role);
    for (const kind of ['cold', 'warm']) {
      for (const path of pages) {
        const r = await visit(page, path);
        results.push({ round, role, kind, path, ...r });
        console.log(`${role.padEnd(10)} ${kind} ${path.padEnd(24)} firstData=${r.firstDataMs}ms usable=${r.usableMs}ms api=${r.apiRequests} non2xx=${r.non2xx}`);
        await sleep(PACE_MS);
      }
    }
    await context.close();
  }
}
fs.writeFileSync(`${OUT}/perf-nav.json`, JSON.stringify(results, null, 2));

const median = (xs) => { const s = xs.filter((x) => x !== null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const summary = {};
for (const r of results) {
  const k = `${r.role} ${r.kind} ${r.path}`;
  (summary[k] ??= { firstData: [], usable: [], api: [], non2xx: 0 });
  summary[k].firstData.push(r.firstDataMs); summary[k].usable.push(r.usableMs); summary[k].api.push(r.apiRequests); summary[k].non2xx += r.non2xx;
}
const rows = Object.entries(summary).map(([k, v]) => ({ visit: k, firstDataMedianMs: median(v.firstData), usableMedianMs: median(v.usable), usableMaxMs: Math.max(...v.usable), apiRequestsMedian: median(v.api), non2xx: v.non2xx }));
fs.writeFileSync(`${OUT}/perf-nav-summary.json`, JSON.stringify(rows, null, 2));
console.table(rows);
