#!/usr/bin/env node
// Production rollout verification for deploy-production.yml (POS-PERF-P43).
//
// Replaces the old blind `sleep 45`. Each check is bound to the exact commit
// this run validated and deploys, never to "whatever is live now":
//   render-preflight — before any production write, require the pinned
//                  Render service (repo/branch) with Auto-Deploy off.
//   render       — re-run that check, then trigger the Render deploy hook for EXPECTED_SHA, then poll
//                  that deploy (by id) on RENDER_SERVICE_ID until it is live.
//   web-mode     — read apps/web/vercel.json at this commit and say who
//                  publishes the production web: Vercel's Git integration
//                  ("git") or this workflow ("workflow").
//   vercel-verify — poll until every production domain is aliased to a READY
//                  production deployment of EXPECTED_SHA in the pinned project.
//
// No dependencies beyond Node 24 (global fetch, node:fs). Secrets are only read
// from env and are scrubbed from every message this script prints.

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export class FatalError extends Error {}
export class TransientError extends Error {}

/** Replace every occurrence of each non-empty secret with ***. */
export function sanitize(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('***');
  }
  return out;
}

/** Secrets to scrub for a hook URL: the whole URL, and its query values. */
export function hookSecrets(hookUrl) {
  if (!hookUrl) return [];
  const parts = [hookUrl];
  try {
    const u = new URL(hookUrl);
    for (const v of u.searchParams.values()) parts.push(v);
    parts.push(u.pathname);
  } catch {
    // Not a URL: the whole string is still scrubbed.
  }
  return parts;
}

function isTransientStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/** fetch JSON; network errors and 408/429/5xx are transient, other non-2xx fatal. */
export async function fetchJson(fetchImpl, url, init, what) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    // Never print err.cause: undici includes the request URL in some causes.
    const code = err?.cause?.code ?? err?.name ?? 'error';
    throw new TransientError(`${what}: network error (${code})`);
  }
  if (!res.ok) {
    const msg = `${what}: HTTP ${res.status}`;
    if (isTransientStatus(res.status)) throw new TransientError(msg);
    throw new FatalError(msg);
  }
  try {
    return { status: res.status, body: await res.json() };
  } catch {
    throw new TransientError(`${what}: response was not JSON`);
  }
}

/**
 * Bounded poll. `check` returns { done: true, value } or { done: false, note };
 * throwing FatalError stops immediately; TransientError is retried until
 * `maxConsecutiveErrors` in a row. The deadline is checked before every wait.
 */
export async function pollUntil({
  check,
  intervalMs,
  timeoutMs,
  maxConsecutiveErrors = 5,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
  label,
}) {
  const deadline = now() + timeoutMs;
  let consecutiveErrors = 0;
  let lastNote = 'no response yet';
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await check(attempt);
      consecutiveErrors = 0;
      if (r.done) return r.value;
      lastNote = r.note;
      log(`${label}: ${r.note}`);
    } catch (err) {
      if (!(err instanceof TransientError)) throw err;
      consecutiveErrors++;
      lastNote = err.message;
      log(`${label}: transient error ${consecutiveErrors}/${maxConsecutiveErrors}: ${err.message}`);
      if (consecutiveErrors >= maxConsecutiveErrors) {
        throw new FatalError(
          `${label}: giving up after ${consecutiveErrors} consecutive errors (${err.message})`,
        );
      }
    }
    if (now() + intervalMs > deadline) {
      throw new FatalError(
        `${label}: timed out after ${Math.round(timeoutMs / 1000)}s; last state: ${lastNote}`,
      );
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------- Render ---

const RENDER_API = 'https://api.render.com/v1';
const RENDER_PENDING = new Set([
  'created',
  'queued',
  'build_in_progress',
  'update_in_progress',
  'pre_deploy_in_progress',
]);
// `deactivated` means another deploy replaced this one; it was not verified live.
const RENDER_FAILED = new Set([
  'build_failed',
  'update_failed',
  'pre_deploy_failed',
  'canceled',
  'deactivated',
]);

export function classifyRenderStatus(status) {
  if (status === 'live') return 'live';
  if (RENDER_FAILED.has(status)) return 'failed';
  if (RENDER_PENDING.has(status)) return 'pending';
  return 'unknown';
}

// Retrieve returns the deploy itself; the hook and list wrap it in { deploy }.
const unwrapDeploy = (x) => (x && typeof x === 'object' && x.deploy ? x.deploy : x);

/** "https://github.com/Owner/Repo.git/" and "git@github.com:owner/repo" → "github.com/owner/repo". */
export function normalizeRepo(repo) {
  return String(repo)
    .trim()
    .toLowerCase()
    .replace(/^git@github\.com:/, 'github.com/')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

/**
 * Fail-closed preflight of the production Render service, run before any
 * production write. Passes only when `serviceId` is the pinned
 * `expectedServiceId`, the API returns that service, it is built from
 * `expectedRepo` / `expectedBranch`, and Auto-Deploy is exactly "no" —
 * otherwise Render would also deploy every main push without this gate.
 * Enabled, missing or unrecognised autoDeploy, a malformed body, and any
 * non-transient API error all fail. Nothing is ever changed on Render.
 */
export async function checkRenderService({
  apiKey,
  serviceId,
  expectedServiceId,
  expectedRepo,
  expectedBranch,
  fetchImpl,
  intervalMs = 15_000,
  timeoutMs = 3 * 60_000,
  maxConsecutiveErrors = 5,
  now,
  sleep,
  log = () => {},
}) {
  if (expectedServiceId && serviceId !== expectedServiceId) {
    throw new FatalError(
      `RENDER_SERVICE_ID_PRODUCTION does not match the pinned production service ${expectedServiceId}`,
    );
  }
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  const service = await pollUntil({
    label: 'Render service',
    intervalMs,
    timeoutMs,
    maxConsecutiveErrors,
    now,
    sleep,
    log,
    check: async () => {
      try {
        const { body } = await fetchJson(
          fetchImpl,
          `${RENDER_API}/services/${encodeURIComponent(serviceId)}`,
          { headers },
          'Render service lookup',
        );
        return { done: true, value: body };
      } catch (err) {
        if (err instanceof FatalError && /HTTP 404/.test(err.message)) {
          throw new FatalError(
            'Render service lookup: HTTP 404 — RENDER_SERVICE_ID_PRODUCTION does not name a service this API key can see',
          );
        }
        throw err;
      }
    },
  });
  if (!service || typeof service !== 'object' || Array.isArray(service)) {
    throw new FatalError('Render service lookup: response was not a service object');
  }
  if (service.id !== serviceId) {
    throw new FatalError(
      service.id
        ? 'Render service lookup returned a different service id'
        : 'Render service lookup: response has no service id',
    );
  }
  if (expectedRepo) {
    if (typeof service.repo !== 'string' || !service.repo) {
      throw new FatalError(`Render service ${serviceId} reports no repository`);
    }
    if (normalizeRepo(service.repo) !== normalizeRepo(expectedRepo)) {
      throw new FatalError(
        `Render service ${serviceId} is built from ${service.repo}, expected ${expectedRepo}`,
      );
    }
  }
  if (expectedBranch && service.branch !== expectedBranch) {
    throw new FatalError(
      `Render service ${serviceId} tracks branch ${service.branch ?? '(none)'}, expected ${expectedBranch}`,
    );
  }
  if (service.autoDeploy === 'yes') {
    throw new FatalError(
      `Render Auto-Deploy is ON for ${serviceId}: Render would also deploy every main push without validation or approval. Turn it off in the Render dashboard (Settings → Auto-Deploy), then re-run. Nothing was deployed.`,
    );
  }
  if (service.autoDeploy !== 'no') {
    throw new FatalError(
      `Render Auto-Deploy setting for ${serviceId} is unknown (${service.autoDeploy === undefined ? 'missing' : JSON.stringify(service.autoDeploy)}); refusing to deploy until it reads "no"`,
    );
  }
  return {
    id: service.id,
    name: service.name,
    repo: service.repo,
    branch: service.branch,
    autoDeploy: service.autoDeploy,
  };
}

/** POST the deploy hook for `sha`. Returns the new deploy id, or null on 202 (queued, no id). */
export async function triggerRenderDeploy({ hookUrl, sha, fetchImpl }) {
  let url;
  try {
    url = new URL(hookUrl);
  } catch {
    throw new FatalError('Render deploy hook: secret is not a valid URL');
  }
  url.searchParams.set('ref', sha);
  // Not retried: a lost response could still have started a deploy, and a
  // second POST would start another. Re-run the job instead.
  let res;
  try {
    res = await fetchImpl(url.toString(), { method: 'POST' });
  } catch (err) {
    throw new FatalError(
      `Render deploy hook: network error (${err?.cause?.code ?? err?.name ?? 'error'})`,
    );
  }
  if (res.status === 202) return null;
  if (res.status !== 200) throw new FatalError(`Render deploy hook: HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new FatalError('Render deploy hook: 200 response was not JSON');
  }
  const id = unwrapDeploy(body)?.id;
  if (typeof id !== 'string' || !id)
    throw new FatalError('Render deploy hook: 200 response had no deploy id');
  return id;
}

/**
 * Wait for the deploy this run triggered to be live on `serviceId` at `sha`.
 * With a deploy id it polls only that deploy. Without one (hook answered 202),
 * it waits for a deploy_hook deploy of `sha` created after `triggeredAt` to
 * appear on the service, then follows that one — never "the latest deploy".
 */
export async function waitForRenderDeploy({
  apiKey,
  serviceId,
  expectedServiceId,
  expectedRepo,
  expectedBranch,
  sha,
  deployId,
  triggeredAt,
  fetchImpl,
  intervalMs = 15_000,
  timeoutMs = 25 * 60_000,
  maxConsecutiveErrors = 5,
  now,
  sleep,
  log = () => {},
}) {
  // One deadline across service lookup, deploy lookup and status polling.
  const clock = now ?? Date.now;
  const deadline = clock() + timeoutMs;
  const remaining = () => Math.max(0, deadline - clock());
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  const svc = `${RENDER_API}/services/${encodeURIComponent(serviceId)}`;

  // Same fail-closed check as the preflight, re-read while following the deploy.
  await checkRenderService({
    apiKey,
    serviceId,
    expectedServiceId,
    expectedRepo,
    expectedBranch,
    fetchImpl,
    intervalMs,
    timeoutMs: remaining(),
    maxConsecutiveErrors,
    now: clock,
    sleep,
    log,
  });

  let id = deployId;
  if (!id) {
    log(
      'Render hook answered 202 (queued behind another deploy, no id). Waiting for a deploy_hook deploy of this commit to appear.',
    );
    const since = triggeredAt - 120_000; // tolerate clock skew between runner and Render
    id = await pollUntil({
      label: 'Render deploy lookup',
      intervalMs,
      timeoutMs: remaining(),
      maxConsecutiveErrors,
      now: clock,
      sleep,
      log,
      check: async () => {
        const { body } = await fetchJson(
          fetchImpl,
          `${svc}/deploys?limit=20`,
          { headers },
          'Render deploy list',
        );
        const candidates = (Array.isArray(body) ? body : [])
          .map(unwrapDeploy)
          .filter(
            (d) =>
              d?.commit?.id === sha &&
              d.trigger === 'deploy_hook' &&
              Date.parse(d.createdAt) >= since,
          )
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        if (candidates.length === 0)
          return { done: false, note: `no deploy_hook deploy of ${sha.slice(0, 7)} yet` };
        return { done: true, value: candidates[0].id };
      },
    });
  }

  return pollUntil({
    label: `Render deploy ${id}`,
    intervalMs,
    timeoutMs: remaining(),
    maxConsecutiveErrors,
    now: clock,
    sleep,
    log,
    check: async () => {
      let body;
      try {
        ({ body } = await fetchJson(
          fetchImpl,
          `${svc}/deploys/${encodeURIComponent(id)}`,
          { headers },
          'Render deploy status',
        ));
      } catch (err) {
        if (err instanceof FatalError && /HTTP 404/.test(err.message)) {
          throw new FatalError(
            `Render deploy ${id} not found on this service — the deploy hook belongs to a different service than RENDER_SERVICE_ID_PRODUCTION`,
          );
        }
        throw err;
      }
      const d = unwrapDeploy(body);
      if (d?.id !== id)
        throw new FatalError(`Render returned deploy ${d?.id ?? '(none)'} when asked for ${id}`);
      const commit = d.commit?.id;
      if (commit && commit !== sha) {
        throw new FatalError(`Render deploy ${id} is for commit ${commit}, expected ${sha}`);
      }
      const state = classifyRenderStatus(d.status);
      if (state === 'failed') throw new FatalError(`Render deploy ${id} ended as ${d.status}`);
      if (state === 'live') {
        if (commit !== sha)
          throw new FatalError(`Render deploy ${id} is live but reports no commit id`);
        return { done: true, value: { id, status: d.status, commit } };
      }
      return {
        done: false,
        note: `${d.status ?? 'no status'} (commit ${commit ? commit.slice(0, 7) : 'unknown'})`,
      };
    },
  });
}

// ---------------------------------------------------------------- Vercel ---

/**
 * Who publishes production web for this commit, from apps/web/vercel.json
 * (`git.deploymentEnabled`, https://vercel.com/docs/project-configuration/git-configuration).
 * "workflow" only when the file turns off Git deploys for main; otherwise
 * Vercel's Git integration publishes it and this workflow must not, so the
 * two can never both deploy (or both skip) the same commit. Glob keys are
 * rejected rather than guessed at.
 */
export function webDeployMode(vercelJsonText) {
  if (vercelJsonText == null) return 'git';
  let cfg;
  try {
    cfg = JSON.parse(vercelJsonText);
  } catch {
    throw new FatalError('apps/web/vercel.json is not valid JSON');
  }
  const de = cfg?.git?.deploymentEnabled;
  if (de === undefined || de === true) return 'git';
  if (de === false) return 'workflow';
  if (typeof de !== 'object' || de === null || Array.isArray(de)) {
    throw new FatalError('git.deploymentEnabled must be a boolean or an object of branch: boolean');
  }
  const globKeys = Object.keys(de).filter((k) => /[*?[\]{}!]/.test(k));
  if (globKeys.length > 0) {
    throw new FatalError(
      `git.deploymentEnabled uses glob keys (${globKeys.join(', ')}); use an exact "main" key so the publisher is unambiguous`,
    );
  }
  if (de.main === false) return 'workflow';
  if (de.main === undefined || de.main === true) return 'git';
  throw new FatalError('git.deploymentEnabled.main must be a boolean');
}

const VERCEL_API = 'https://api.vercel.com';

/**
 * Wait until every domain is aliased to one READY production deployment of
 * `sha` in `projectId`. When `deploymentId` is given (workflow mode) the
 * aliases must point at exactly that deployment.
 */
export async function waitForVercelProduction({
  token,
  teamId,
  projectId,
  domains,
  sha,
  deploymentId,
  fetchImpl,
  intervalMs = 10_000,
  timeoutMs = 15 * 60_000,
  maxConsecutiveErrors = 5,
  now,
  sleep,
  log = () => {},
}) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const q = `teamId=${encodeURIComponent(teamId)}`;
  return pollUntil({
    label: 'Vercel production',
    intervalMs,
    timeoutMs,
    maxConsecutiveErrors,
    now,
    sleep,
    log,
    check: async () => {
      const targets = new Set();
      for (const domain of domains) {
        const { body } = await fetchJson(
          fetchImpl,
          `${VERCEL_API}/v4/aliases/${encodeURIComponent(domain)}?${q}&projectId=${encodeURIComponent(projectId)}`,
          { headers },
          `Vercel alias ${domain}`,
        );
        if (body.projectId && body.projectId !== projectId) {
          throw new FatalError(`Vercel alias ${domain} belongs to another project`);
        }
        targets.add(body.deploymentId ?? body.deployment?.id);
      }
      if (targets.size !== 1 || targets.has(undefined) || targets.has(null)) {
        return {
          done: false,
          note: `domains point at different deployments (${[...targets].join(', ')})`,
        };
      }
      const [current] = targets;
      if (deploymentId && current !== deploymentId) {
        return { done: false, note: `domains still on ${current}, waiting for ${deploymentId}` };
      }
      const { body: d } = await fetchJson(
        fetchImpl,
        `${VERCEL_API}/v13/deployments/${encodeURIComponent(current)}?${q}`,
        { headers },
        `Vercel deployment ${current}`,
      );
      if (d.projectId !== projectId)
        throw new FatalError(`Vercel deployment ${current} is not in the pinned project`);
      const deployedSha = d.meta?.githubCommitSha;
      if (deploymentId) {
        // Our own CLI deployment of this checkout; a recorded SHA must still agree.
        if (deployedSha && deployedSha !== sha) {
          throw new FatalError(
            `Vercel deployment ${current} records commit ${deployedSha}, expected ${sha}`,
          );
        }
      } else if (deployedSha !== sha) {
        return {
          done: false,
          note: `domains on ${current} (commit ${deployedSha ? deployedSha.slice(0, 7) : 'unknown'}), waiting for ${sha.slice(0, 7)}`,
        };
      }
      if (d.target !== 'production')
        throw new FatalError(`Vercel deployment ${current} target is ${d.target}, not production`);
      if (d.readyState !== 'READY') return { done: false, note: `${current} is ${d.readyState}` };
      return { done: true, value: { id: current, sha: deployedSha ?? sha } };
    },
  });
}

/** Resolve a deployment URL printed by `vercel deploy` to its id. */
export async function vercelDeploymentIdFromUrl({ token, teamId, url, fetchImpl }) {
  const host = new URL(url).host;
  const { body } = await fetchJson(
    fetchImpl,
    `${VERCEL_API}/v13/deployments/${encodeURIComponent(host)}?teamId=${encodeURIComponent(teamId)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    `Vercel deployment ${host}`,
  );
  if (!body.id) throw new FatalError(`Vercel deployment ${host}: no id in response`);
  return body.id;
}

// ------------------------------------------------------------------- CLI ---

function requireEnv(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new FatalError(`missing required environment: ${missing.join(', ')}`);
  return names.map((n) => env[n]);
}

export async function main(
  argv,
  env,
  { fetchImpl = fetch, out = console.log, err = console.error } = {},
) {
  const [cmd, arg] = argv;
  let secrets = [];
  const say = (m) => out(sanitize(m, secrets));
  try {
    if (cmd === 'web-mode') {
      const path = arg ?? 'apps/web/vercel.json';
      const mode = webDeployMode(existsSync(path) ? readFileSync(path, 'utf8') : null);
      out(mode);
      return 0;
    }
    if (cmd === 'render-preflight') {
      const [apiKey, serviceId, expectedServiceId, expectedRepo, expectedBranch] = requireEnv(env, [
        'RENDER_API_KEY',
        'RENDER_SERVICE_ID_PRODUCTION',
        'RENDER_EXPECTED_SERVICE_ID',
        'RENDER_EXPECTED_REPO',
        'RENDER_EXPECTED_BRANCH',
      ]);
      secrets = [apiKey];
      const s = await checkRenderService({
        apiKey,
        serviceId,
        expectedServiceId,
        expectedRepo,
        expectedBranch,
        fetchImpl,
        log: say,
      });
      say(
        `Render service ${s.id} (${s.name ?? 'unnamed'}): repo ${s.repo}, branch ${s.branch}, autoDeploy=${s.autoDeploy}. OK`,
      );
      return 0;
    }
    if (cmd === 'render') {
      const [hookUrl, apiKey, serviceId, expectedServiceId, expectedRepo, expectedBranch, sha] =
        requireEnv(env, [
          'RENDER_DEPLOY_HOOK_PRODUCTION',
          'RENDER_API_KEY',
          'RENDER_SERVICE_ID_PRODUCTION',
          'RENDER_EXPECTED_SERVICE_ID',
          'RENDER_EXPECTED_REPO',
          'RENDER_EXPECTED_BRANCH',
          'EXPECTED_SHA',
        ]);
      secrets = [...hookSecrets(hookUrl), apiKey];
      const expected = { expectedServiceId, expectedRepo, expectedBranch };
      // Re-checked immediately before the hook: the setting could have
      // changed while migrations ran, and the hook must not fire if it did.
      await checkRenderService({ apiKey, serviceId, ...expected, fetchImpl, log: say });
      const triggeredAt = Date.now();
      const deployId = await triggerRenderDeploy({ hookUrl, sha, fetchImpl });
      say(
        deployId
          ? `Render deploy hook started ${deployId} for ${sha}`
          : `Render deploy hook queued a deploy for ${sha}`,
      );
      const r = await waitForRenderDeploy({
        apiKey,
        serviceId,
        ...expected,
        sha,
        deployId,
        triggeredAt,
        fetchImpl,
        log: say,
      });
      say(`Render deploy ${r.id} is live at ${r.commit}`);
      return 0;
    }
    if (cmd === 'vercel-verify') {
      const [token, teamId, projectId, sha, domainList] = requireEnv(env, [
        'VERCEL_TOKEN',
        'VERCEL_ORG_ID',
        'VERCEL_PROJECT_ID',
        'EXPECTED_SHA',
        'VERCEL_PRODUCTION_DOMAINS',
      ]);
      secrets = [token];
      const domains = domainList
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
      const deploymentId = env.VERCEL_DEPLOYMENT_URL
        ? await vercelDeploymentIdFromUrl({
            token,
            teamId,
            url: env.VERCEL_DEPLOYMENT_URL,
            fetchImpl,
          })
        : undefined;
      const r = await waitForVercelProduction({
        token,
        teamId,
        projectId,
        domains,
        sha,
        deploymentId,
        fetchImpl,
        log: say,
      });
      say(`Vercel production (${domains.join(', ')}) is ${r.id} at ${r.sha}`);
      return 0;
    }
    err(
      'usage: deploy-rollout.mjs render-preflight | render | web-mode [vercel.json] | vercel-verify',
    );
    return 2;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err(sanitize(`::error::${msg}`, secrets));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
