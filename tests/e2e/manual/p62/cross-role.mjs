// POS-PERF-P62 — the same filters must give the same totals to every role that can
// see them. Calls the endpoints the Admin, Supervisor and Branch screens use,
// signed in as each role through the web origin (LOCAL stack only). This compares
// API answers, not values read off the screens.
//
//   node tests/e2e/manual/p62/cross-role.mjs
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { WEB, OUT, ACCOUNTS, check, saveResults } from './lib.mjs';

async function signIn(role) {
  const device = randomUUID();
  const res = await fetch(`${WEB}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ACCOUNTS[role].email, password: ACCOUNTS[role].password, device_id: device }) });
  const body = await res.json();
  if (!body?.data?.access_token) throw new Error(`${role} sign-in failed: ${res.status}`);
  return { token: body.data.access_token, device };
}
async function get(session, path) {
  const res = await fetch(`${WEB}${path}`, { headers: { authorization: `Bearer ${session.token}`, 'x-device-id': session.device } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const manila = (d) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const to = manila(new Date());
const from = manila(new Date(Date.now() - 29 * 86_400_000));
const sessions = { admin: await signIn('admin'), supervisor: await signIn('supervisor'), branch: await signIn('branch') };
const branches = (await get(sessions.supervisor, '/api/branches?status=active&page=1&limit=100')).body?.data;
const list = branches?.branches ?? branches ?? [];
const main = list.find((b) => b.code === 'MAIN01');
const other = list.find((b) => b.code === 'P62B1');
if (!main || !other) throw new Error('fixture branches not visible to the supervisor');

const evidence = {};
for (const [label, path] of [
  ['expense summary', `/api/expenses/summary?branch_id=${main.id}&date_from=${from}&date_to=${to}`],
  ['period summary', `/api/reports/period-summary?branch_id=${main.id}&date_from=${from}&date_to=${to}`],
  ['payment mix', `/api/reports/payment-method-mix?branch_id=${main.id}&date_from=${from}&date_to=${to}&page=1&limit=100`],
]) {
  const answers = {};
  for (const role of ['admin', 'supervisor', 'branch']) answers[role] = await get(sessions[role], path);
  const statuses = Object.fromEntries(Object.entries(answers).map(([r, a]) => [r, a.status]));
  const data = Object.fromEntries(Object.entries(answers).filter(([, a]) => a.status === 200).map(([r, a]) => [r, JSON.stringify(a.body?.data)]));
  const distinct = new Set(Object.values(data));
  evidence[label] = { statuses, sample: Object.values(data)[0]?.slice(0, 400) };
  check(`cross-role: ${label} is identical for every role allowed to read it`, distinct.size === 1 && Object.keys(data).length >= 2, { statuses, roles: Object.keys(data) });
}

// Supervisor branch switching: the other branch's figures differ and never leak into MAIN01's.
const mainSummary = await get(sessions.supervisor, `/api/expenses/summary?branch_id=${main.id}&date_from=${from}&date_to=${to}`);
const otherSummary = await get(sessions.supervisor, `/api/expenses/summary?branch_id=${other.id}&date_from=${from}&date_to=${to}`);
const branchForeign = await get(sessions.branch, `/api/expenses/summary?branch_id=${other.id}&date_from=${from}&date_to=${to}`);
check('cross-role: switching the Supervisor to another branch changes the figures', mainSummary.status === 200 && otherSummary.status === 200 && JSON.stringify(mainSummary.body?.data) !== JSON.stringify(otherSummary.body?.data), {});
check("cross-role: a Branch account cannot read another branch's figures", branchForeign.status === 403 || branchForeign.status === 404, { status: branchForeign.status });
fs.writeFileSync(`${OUT}/cross-role.json`, JSON.stringify({ from, to, evidence }, null, 2));
process.exit(saveResults('cross-role') ? 1 : 0);
