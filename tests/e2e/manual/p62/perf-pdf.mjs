// POS-PERF-P62 — PDF load against the LOCAL stack (production API build, PDF worker).
//
//   node tests/e2e/manual/p62/perf-pdf.mjs <label> <concurrent> [days=7] [holdMs=0]
//
// Signs in as the seeded Supervisor through the web origin (as a browser would),
// then: probes GET /health on the API every 50ms for the whole run (its gaps show
// event-loop stalls), and starts <concurrent> Transaction PDF exports for MAIN01
// over the last <days> days at once. Records each export's status, duration,
// size, %PDF- signature or error code. With concurrent=0 it is the idle baseline.
// holdMs keeps the probe running after the exports finish (for overlap with UI
// checkout timing run alongside). LOCAL laptop timings, not hosted Render.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WEB, OUT, ACCOUNTS, sleep } from './lib.mjs';

const [label = 'run', concurrentArg = '0', daysArg = '7', holdArg = '0'] = process.argv.slice(2);
const API = process.env.P62_API_URL || 'http://127.0.0.1:56432';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(API)) throw new Error('Refusing: P62_API_URL must be local');
const concurrent = Number(concurrentArg);
const days = Number(daysArg);
const holdMs = Number(holdArg);
const deviceId = randomUUID();

async function signIn() {
  const res = await fetch(`${WEB}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ACCOUNTS.supervisor.email, password: ACCOUNTS.supervisor.password, device_id: deviceId }) });
  const body = await res.json();
  if (!body?.data?.access_token) throw new Error(`sign-in failed: ${res.status}`);
  return body.data.access_token;
}

async function mainBranchId(token) {
  const res = await fetch(`${WEB}/api/branches?status=active&page=1&limit=100`, { headers: { authorization: `Bearer ${token}`, 'x-device-id': deviceId } });
  const body = await res.json();
  const list = body?.data?.branches ?? body?.data ?? [];
  const main = list.find((b) => b.code === 'MAIN01');
  if (!main) throw new Error('MAIN01 not visible to the supervisor');
  return main.id;
}

const manila = (d) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

const probe = { samples: [], stop: false };
async function runProbe() {
  let last = Date.now();
  while (!probe.stop) {
    const t = Date.now();
    try { await fetch(`${API}/health`); } catch { /* counted as a gap */ }
    const now = Date.now();
    probe.samples.push({ at: t, rtt: now - t, gap: now - last });
    last = now;
    await sleep(50);
  }
}

async function exportPdf(token, branchId, n) {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  const url = `${WEB}/api/transactions/export/pdf?branch_id=${branchId}&date_from=${manila(from)}&date_to=${manila(to)}`;
  const t0 = Date.now();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, 'x-device-id': deviceId } });
  const bytes = Buffer.from(await res.arrayBuffer());
  const ms = Date.now() - t0;
  const isPdf = bytes.subarray(0, 5).toString('latin1') === '%PDF-';
  let code = null;
  if (!isPdf) { try { code = JSON.parse(bytes.toString('utf8'))?.error?.code ?? null; } catch { code = 'non-json'; } }
  const out = { n, status: res.status, ms, bytes: bytes.length, isPdf, code, retryAfter: res.headers.get('retry-after') };
  if (isPdf && n === 1) fs.writeFileSync(`${OUT}/pdf-${label}-sample.pdf`, bytes);
  return out;
}

const token = await signIn();
const branchId = await mainBranchId(token);
const probing = runProbe();
await sleep(2000);
const tExports = Date.now();
const exports = await Promise.all(Array.from({ length: concurrent }, (_, i) => exportPdf(token, branchId, i + 1)));
const exportsMs = Date.now() - tExports;
if (holdMs) await sleep(holdMs);
await sleep(1000);
probe.stop = true;
await probing;

const gaps = probe.samples.map((s) => s.gap).sort((a, b) => a - b);
const rtts = probe.samples.map((s) => s.rtt).sort((a, b) => a - b);
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const result = {
  label, concurrent, days, at: new Date().toISOString(),
  exports, exportsWallMs: exportsMs,
  health: { samples: probe.samples.length, rttP50: pct(rtts, 0.5), rttP95: pct(rtts, 0.95), rttMax: rtts[rtts.length - 1], worstGapMs: gaps[gaps.length - 1] },
};
fs.writeFileSync(`${OUT}/perf-pdf-${label}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ label, concurrent, exportsWallMs: exportsMs, exports: exports.map((e) => `${e.status}${e.code ? ' ' + e.code : ''} ${e.ms}ms ${e.isPdf ? e.bytes + 'B' : ''}`), health: result.health }));
