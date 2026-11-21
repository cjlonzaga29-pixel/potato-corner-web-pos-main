// POS-PERF-P62 — PDF capacity on the LOCAL stack, three workloads kept apart:
//
//   node tests/e2e/manual/p62/pdf-capacity.mjs <label> [workloads=sequential,realistic,saturation]
//
//   sequential — one person exporting, one after another: 3 × 1-day, 3 × 7-day.
//   realistic  — three people on different devices asking within a few seconds of
//                each other (arrivals 0s, 4s, 9s), each a 1-day Transaction PDF,
//                then the same with 7-day PDFs.
//   saturation — the earlier overload test, unchanged: 4 rounds of 3 simultaneous
//                7-day exports, each round starting when the last answer arrives.
//
// Every export goes through the web's /api rewrite (the browser's path) as the
// seeded Supervisor for MAIN01. Alongside each workload an authenticated read
// (GET /api/branches/stats) runs every 500ms, so its latency under load is
// measured too. Per export: status, ms, size, %PDF- check, error code, Retry-After.
// Paced between workloads so no per-user or per-IP budget is reached.
// LOCAL laptop timings (machine and dataset in the runbook), not hosted Render.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WEB, OUT, ACCOUNTS, sleep } from './lib.mjs';

const [label = 'run', which = 'sequential,realistic,saturation'] = process.argv.slice(2);
const workloads = which.split(',');
const deviceId = randomUUID();
const manila = (d) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const PACE_MS = Number(process.env.P62_PACE_MS || 20000);

const login = await (await fetch(`${WEB}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ACCOUNTS.supervisor.email, password: ACCOUNTS.supervisor.password, device_id: deviceId }) })).json();
const token = login?.data?.access_token;
if (!token) throw new Error('sign-in failed');
const auth = { authorization: `Bearer ${token}`, 'x-device-id': deviceId };
const branches = (await (await fetch(`${WEB}/api/branches?status=active&page=1&limit=100`, { headers: auth })).json()).data;
const main = (branches?.branches ?? branches).find((b) => b.code === 'MAIN01');

async function exportPdf(days, tag) {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  const t0 = Date.now();
  const res = await fetch(`${WEB}/api/transactions/export/pdf?branch_id=${main.id}&date_from=${manila(from)}&date_to=${manila(to)}`, { headers: auth });
  const bytes = Buffer.from(await res.arrayBuffer());
  const isPdf = bytes.subarray(0, 5).toString('latin1') === '%PDF-' && bytes.length > 1000;
  let code = null;
  if (!isPdf) { try { code = JSON.parse(bytes.toString('utf8'))?.error?.code ?? 'no-code'; } catch { code = 'non-json'; } }
  return { tag, days, status: res.status, ms: Date.now() - t0, bytes: bytes.length, isPdf, code, retryAfter: res.headers.get('retry-after') };
}

function startReads() {
  const samples = [];
  let stop = false;
  const done = (async () => {
    while (!stop) {
      const t0 = Date.now();
      const res = await fetch(`${WEB}/api/branches/stats?branch_id=${main.id}`, { headers: auth }).catch(() => null);
      samples.push({ ms: Date.now() - t0, status: res?.status ?? 0 });
      await sleep(500);
    }
  })();
  return async () => {
    stop = true;
    await done;
    const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
    const pct = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
    return { n: samples.length, failed: samples.filter((s) => s.status !== 200).length, p50: pct(0.5), p95: pct(0.95), max: ms[ms.length - 1] };
  };
}

const plans = {
  async sequential() {
    const out = [];
    for (const days of [1, 1, 1, 7, 7, 7]) out.push(await exportPdf(days, `seq-${days}d`));
    return out;
  },
  async realistic() {
    const out = [];
    for (const days of [1, 7]) {
      const arrivals = [0, 4000, 9000];
      const t0 = Date.now();
      out.push(...(await Promise.all(arrivals.map(async (at, i) => { await sleep(Math.max(0, at - (Date.now() - t0))); return exportPdf(days, `real-${days}d-user${i + 1}@${at / 1000}s`); }))));
      await sleep(PACE_MS);
    }
    return out;
  },
  async saturation() {
    const out = [];
    for (let round = 1; round <= 4; round += 1) out.push(...(await Promise.all([1, 2, 3].map((i) => exportPdf(7, `sat-r${round}-${i}`)))));
    return out;
  },
};

const results = { label, at: new Date().toISOString(), branch: 'MAIN01', workloads: {} };
for (const w of workloads) {
  const stopReads = startReads();
  const t0 = Date.now();
  const exports = await plans[w]();
  const wallMs = Date.now() - t0;
  const reads = await stopReads();
  const ok = exports.filter((e) => e.isPdf);
  const refused = exports.filter((e) => !e.isPdf);
  results.workloads[w] = {
    exports, wallMs, reads,
    succeeded: ok.length, total: exports.length,
    okMs: ok.map((e) => e.ms),
    refusedMs: refused.map((e) => `${e.code}@${e.ms}`),
    corruptSuccess: exports.filter((e) => e.status === 200 && !e.isPdf).length,
  };
  console.log(`${w}: ${ok.length}/${exports.length} ok; ok ms ${JSON.stringify(ok.map((e) => e.ms))}; refused ${JSON.stringify(refused.map((e) => `${e.code}@${e.ms}`))}; reads p50 ${reads.p50} p95 ${reads.p95} max ${reads.max} failed ${reads.failed}`);
  await sleep(PACE_MS);
}
fs.writeFileSync(`${OUT}/pdf-capacity-${label}.json`, JSON.stringify(results, null, 2));
