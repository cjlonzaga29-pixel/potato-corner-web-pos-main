// Run: node --test ".github/scripts/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FatalError,
  checkRenderService,
  classifyRenderStatus,
  main,
  normalizeRepo,
  parseVercelDeployOutput,
  promoteVercelDeployment,
  pollUntil,
  sanitize,
  triggerRenderDeploy,
  waitForRenderDeploy,
  waitForVercelProduction,
  webDeployMode,
} from './deploy-rollout.mjs';

const SHA = '1111111111111111111111111111111111111111';
const OLD_SHA = '0000000000000000000000000000000000000000';
const SERVICE = 'srv-expected';
const API_KEY = 'rnd_SECRETAPIKEYvalue';
const HOOK = 'https://api.render.com/deploy/srv-expected?key=HOOKSECRETkey';
const VERCEL_TOKEN = 'vercelTOKENsecretvalue';

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** Fake clock: sleep() advances now() instead of waiting. */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

/**
 * Fake fetch. `routes` maps a URL substring to a list of responses (or
 * functions / thrown errors); the last entry repeats. Records every call.
 */
function fakeFetch(routes) {
  const calls = [];
  const counters = new Map();
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const key = Object.keys(routes)
      .filter((k) => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`unexpected fetch ${url}`);
    const list = routes[key];
    const i = counters.get(key) ?? 0;
    counters.set(key, i + 1);
    const r = list[Math.min(i, list.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(url, init) : r;
  };
  return { impl, calls };
}

const REPO = 'https://github.com/cjlonzaga29-pixel/potato-corner-web-pos-main';
const serviceBody = {
  id: SERVICE,
  name: 'potato-corner-api',
  autoDeploy: 'no',
  repo: REPO,
  branch: 'main',
};
const service = json(200, serviceBody);
const EXPECTED = { expectedServiceId: SERVICE, expectedRepo: REPO, expectedBranch: 'main' };
const RENDER_ENV = {
  RENDER_DEPLOY_HOOK_PRODUCTION: HOOK,
  RENDER_API_KEY: API_KEY,
  RENDER_SERVICE_ID_PRODUCTION: SERVICE,
  RENDER_EXPECTED_SERVICE_ID: SERVICE,
  RENDER_EXPECTED_REPO: REPO,
  RENDER_EXPECTED_BRANCH: 'main',
  EXPECTED_SHA: SHA,
};
const deploy = (id, status, sha = SHA, extra = {}) =>
  json(200, { id, status, commit: { id: sha }, trigger: 'deploy_hook', ...extra });

function renderArgs(fetchImpl, over = {}) {
  const clock = fakeClock();
  return {
    apiKey: API_KEY,
    serviceId: SERVICE,
    sha: SHA,
    deployId: 'dep-new',
    triggeredAt: clock.now(),
    fetchImpl,
    intervalMs: 10_000,
    timeoutMs: 120_000,
    maxConsecutiveErrors: 3,
    now: clock.now,
    sleep: clock.sleep,
    ...over,
  };
}

// ------------------------------------------------------------ status map ---

test('classifies every documented Render status', () => {
  assert.equal(classifyRenderStatus('live'), 'live');
  for (const s of [
    'created',
    'queued',
    'build_in_progress',
    'update_in_progress',
    'pre_deploy_in_progress',
  ]) {
    assert.equal(classifyRenderStatus(s), 'pending', s);
  }
  for (const s of [
    'build_failed',
    'update_failed',
    'pre_deploy_failed',
    'canceled',
    'deactivated',
  ]) {
    assert.equal(classifyRenderStatus(s), 'failed', s);
  }
  assert.equal(classifyRenderStatus('something_new'), 'unknown');
});

// --------------------------------------------------------------- trigger ---

test('hook trigger pins ref to the expected SHA and returns the deploy id', async () => {
  const f = fakeFetch({ '/deploy/srv-expected': [json(200, { deploy: { id: 'dep-new' } })] });
  const id = await triggerRenderDeploy({ hookUrl: HOOK, sha: SHA, fetchImpl: f.impl });
  assert.equal(id, 'dep-new');
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get('ref'), SHA);
  assert.equal(u.searchParams.get('key'), 'HOOKSECRETkey');
  assert.equal(f.calls[0].init.method, 'POST');
});

test('hook trigger returns null on 202 (queued, no id) and fails on other statuses without retrying', async () => {
  const q = fakeFetch({ '/deploy/': [json(202, {})] });
  assert.equal(await triggerRenderDeploy({ hookUrl: HOOK, sha: SHA, fetchImpl: q.impl }), null);
  const bad = fakeFetch({ '/deploy/': [json(503, {})] });
  await assert.rejects(
    triggerRenderDeploy({ hookUrl: HOOK, sha: SHA, fetchImpl: bad.impl }),
    FatalError,
  );
  assert.equal(bad.calls.length, 1, 'a POST that may have started a deploy is never repeated');
  const noId = fakeFetch({ '/deploy/': [json(200, { deploy: {} })] });
  await assert.rejects(
    triggerRenderDeploy({ hookUrl: HOOK, sha: SHA, fetchImpl: noId.impl }),
    /no deploy id/,
  );
});

// ---------------------------------------------------------- render poll ---

test('previous live deploy does not satisfy the check; pending → live of the expected deploy does', async () => {
  const f = fakeFetch({
    [`/services/${SERVICE}`]: [service],
    // The list would show the old live deploy first; with an id it is never consulted.
    [`/services/${SERVICE}/deploys?`]: [
      json(200, [{ deploy: { id: 'dep-old', status: 'live', commit: { id: OLD_SHA } } }]),
    ],
    [`/services/${SERVICE}/deploys/dep-new`]: [
      deploy('dep-new', 'created'),
      deploy('dep-new', 'build_in_progress'),
      deploy('dep-new', 'update_in_progress'),
      deploy('dep-new', 'live'),
    ],
  });
  const logs = [];
  const r = await waitForRenderDeploy(renderArgs(f.impl, { log: (m) => logs.push(m) }));
  assert.deepEqual(r, { id: 'dep-new', status: 'live', commit: SHA });
  assert.ok(
    !f.calls.some((c) => c.url.includes('/deploys?')),
    'never selects from the deploy list when an id is known',
  );
  assert.equal(f.calls.filter((c) => c.url.includes('/deploys/dep-new')).length, 4);
  assert.ok(logs.some((l) => l.includes('build_in_progress')));
});

test('202 path follows only a deploy_hook deploy of this SHA created after the trigger', async () => {
  const clock = fakeClock();
  const t0 = clock.now();
  const listOld = json(200, [
    {
      deploy: {
        id: 'dep-old',
        status: 'live',
        trigger: 'deploy_hook',
        commit: { id: OLD_SHA },
        createdAt: new Date(t0 - 60_000).toISOString(),
      },
    },
    {
      deploy: {
        id: 'dep-stale',
        status: 'deactivated',
        trigger: 'deploy_hook',
        commit: { id: SHA },
        createdAt: new Date(t0 - 3_600_000).toISOString(),
      },
    },
    {
      deploy: {
        id: 'dep-auto',
        status: 'live',
        trigger: 'new_commit',
        commit: { id: SHA },
        createdAt: new Date(t0).toISOString(),
      },
    },
  ]);
  const listNew = json(200, [
    {
      deploy: {
        id: 'dep-mine',
        status: 'queued',
        trigger: 'deploy_hook',
        commit: { id: SHA },
        createdAt: new Date(t0 + 20_000).toISOString(),
      },
    },
    ...(await listOld.json()),
  ]);
  const f = fakeFetch({
    [`/services/${SERVICE}`]: [service],
    [`/services/${SERVICE}/deploys?`]: [listOld, listNew],
    [`/services/${SERVICE}/deploys/dep-mine`]: [
      deploy('dep-mine', 'queued'),
      deploy('dep-mine', 'live'),
    ],
  });
  const r = await waitForRenderDeploy(
    renderArgs(f.impl, { deployId: null, triggeredAt: t0, now: clock.now, sleep: clock.sleep }),
  );
  assert.equal(r.id, 'dep-mine');
});

test('wrong SHA on the triggered deploy fails immediately', async () => {
  const f = fakeFetch({
    [`/services/${SERVICE}`]: [service],
    [`/services/${SERVICE}/deploys/dep-new`]: [deploy('dep-new', 'build_in_progress', OLD_SHA)],
  });
  await assert.rejects(
    waitForRenderDeploy(renderArgs(f.impl)),
    /is for commit 0000000.*expected 1111111/,
  );
});

test('wrong service: unknown service id, foreign service, or deploy not on this service', async () => {
  const missing = fakeFetch({ [`/services/${SERVICE}`]: [json(404, {})] });
  await assert.rejects(waitForRenderDeploy(renderArgs(missing.impl)), /does not name a service/);

  const other = fakeFetch({ [`/services/${SERVICE}`]: [json(200, { id: 'srv-other' })] });
  await assert.rejects(waitForRenderDeploy(renderArgs(other.impl)), /different service id/);

  const foreignDeploy = fakeFetch({
    [`/services/${SERVICE}`]: [service],
    [`/services/${SERVICE}/deploys/dep-new`]: [json(404, {})],
  });
  await assert.rejects(
    waitForRenderDeploy(renderArgs(foreignDeploy.impl)),
    /belongs to a different service/,
  );
});

test('failed, cancelled and replaced deploys fail the rollout', async () => {
  for (const status of [
    'build_failed',
    'update_failed',
    'pre_deploy_failed',
    'canceled',
    'deactivated',
  ]) {
    const f = fakeFetch({
      [`/services/${SERVICE}`]: [service],
      [`/services/${SERVICE}/deploys/dep-new`]: [
        deploy('dep-new', 'build_in_progress'),
        deploy('dep-new', status),
      ],
    });
    await assert.rejects(
      waitForRenderDeploy(renderArgs(f.impl)),
      new RegExp(`ended as ${status}`),
      status,
    );
  }
});

test('live without a commit id is not accepted as this SHA', async () => {
  const f = fakeFetch({
    [`/services/${SERVICE}`]: [service],
    [`/services/${SERVICE}/deploys/dep-new`]: [json(200, { id: 'dep-new', status: 'live' })],
  });
  await assert.rejects(waitForRenderDeploy(renderArgs(f.impl)), /reports no commit id/);
});

test('transient errors are retried within the bound, then give up', async () => {
  const flaky = fakeFetch({
    [`/services/${SERVICE}`]: [new TypeError('fetch failed'), json(503, {}), service],
    [`/services/${SERVICE}/deploys/dep-new`]: [
      json(429, {}),
      json(502, {}),
      deploy('dep-new', 'live'),
    ],
  });
  const r = await waitForRenderDeploy(renderArgs(flaky.impl));
  assert.equal(r.id, 'dep-new');

  const down = fakeFetch({
    [`/services/${SERVICE}`]: [service],
    [`/services/${SERVICE}/deploys/dep-new`]: [json(500, {})],
  });
  await assert.rejects(
    waitForRenderDeploy(renderArgs(down.impl)),
    /giving up after 3 consecutive errors/,
  );
  assert.equal(down.calls.filter((c) => c.url.includes('dep-new')).length, 3);
});

test('auth errors are fatal, not retried', async () => {
  const f = fakeFetch({ [`/services/${SERVICE}`]: [json(401, {})] });
  await assert.rejects(waitForRenderDeploy(renderArgs(f.impl)), /HTTP 401/);
  assert.equal(f.calls.length, 1);
});

test('times out with the last state when the deploy stays pending', async () => {
  const f = fakeFetch({
    [`/services/${SERVICE}`]: [service],
    [`/services/${SERVICE}/deploys/dep-new`]: [deploy('dep-new', 'build_in_progress')],
  });
  await assert.rejects(
    waitForRenderDeploy(renderArgs(f.impl)),
    /timed out after \d+s; last state: build_in_progress/,
  );
  // 120 s budget at 10 s intervals: bounded number of polls, not an endless loop.
  assert.ok(f.calls.length <= 14, `polled ${f.calls.length} times`);
});

test('service, lookup and status phases share one deadline', async () => {
  const clock = fakeClock();
  const f = fakeFetch({
    [`/services/${SERVICE}`]: [json(503, {}), json(503, {}), service],
    [`/services/${SERVICE}/deploys/dep-new`]: [deploy('dep-new', 'build_in_progress')],
  });
  const t0 = clock.now();
  await assert.rejects(
    waitForRenderDeploy(renderArgs(f.impl, { now: clock.now, sleep: clock.sleep })),
    /timed out/,
  );
  assert.ok(clock.now() - t0 <= 120_000, `ran ${clock.now() - t0} ms past a 120 s budget`);
});

// ------------------------------------------------------ render preflight ---

function preflightArgs(fetchImpl, over = {}) {
  const clock = fakeClock();
  return {
    apiKey: API_KEY,
    serviceId: SERVICE,
    ...EXPECTED,
    fetchImpl,
    intervalMs: 10_000,
    timeoutMs: 60_000,
    maxConsecutiveErrors: 3,
    now: clock.now,
    sleep: clock.sleep,
    ...over,
  };
}

const serviceRoute = (...responses) => fakeFetch({ [`/services/${SERVICE}`]: responses });

test('preflight passes only for the pinned service with Auto-Deploy off', async () => {
  const f = serviceRoute(service);
  const r = await checkRenderService(preflightArgs(f.impl));
  assert.deepEqual(r, {
    id: SERVICE,
    name: 'potato-corner-api',
    repo: REPO,
    branch: 'main',
    autoDeploy: 'no',
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${API_KEY}`);
});

test('preflight fails closed when Auto-Deploy is on', async () => {
  const f = serviceRoute(json(200, { ...serviceBody, autoDeploy: 'yes' }));
  await assert.rejects(checkRenderService(preflightArgs(f.impl)), (e) => {
    assert.ok(e instanceof FatalError);
    assert.match(e.message, /Auto-Deploy is ON/);
    return true;
  });
  assert.equal(f.calls.length, 1, 'not retried, and nothing else is called');
});

test('preflight fails closed when Auto-Deploy is missing or unrecognised', async () => {
  const noAutoDeploy = { ...serviceBody };
  delete noAutoDeploy.autoDeploy;
  for (const [body, re] of [
    [noAutoDeploy, /unknown \(missing\)/],
    [{ ...serviceBody, autoDeploy: null }, /unknown \(null\)/],
    [{ ...serviceBody, autoDeploy: 'maybe' }, /unknown \("maybe"\)/],
    [{ ...serviceBody, autoDeploy: false }, /unknown \(false\)/],
    [{ ...serviceBody, autoDeploy: 'No' }, /unknown \("No"\)/],
  ]) {
    await assert.rejects(checkRenderService(preflightArgs(serviceRoute(json(200, body)).impl)), re);
  }
});

test('preflight fails on a malformed service response', async () => {
  for (const [body, re] of [
    [null, /not a service object/],
    [[serviceBody], /not a service object/],
    ['srv-expected', /not a service object/],
    [{ ...serviceBody, id: undefined }, /no service id/],
  ]) {
    await assert.rejects(checkRenderService(preflightArgs(serviceRoute(json(200, body)).impl)), re);
  }
  // A body that is not JSON at all is treated as transient, retried, then fails.
  const notJson = serviceRoute({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('bad');
    },
  });
  await assert.rejects(checkRenderService(preflightArgs(notJson.impl)), /giving up.*not JSON/);
});

test('preflight fails on API errors: auth and 404 at once, 5xx/network after bounded retries', async () => {
  for (const status of [401, 403]) {
    const f = serviceRoute(json(status, {}));
    await assert.rejects(checkRenderService(preflightArgs(f.impl)), new RegExp(`HTTP ${status}`));
    assert.equal(f.calls.length, 1);
  }
  await assert.rejects(
    checkRenderService(preflightArgs(serviceRoute(json(404, {})).impl)),
    /does not name a service/,
  );

  const down = serviceRoute(json(503, {}));
  await assert.rejects(checkRenderService(preflightArgs(down.impl)), /giving up after 3/);
  assert.equal(down.calls.length, 3);

  const net = serviceRoute(
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
  );
  await assert.rejects(
    checkRenderService(preflightArgs(net.impl)),
    /giving up.*network error \(ENOTFOUND\)/,
  );

  // Transient, then recovered: passes.
  const flaky = serviceRoute(json(502, {}), service);
  assert.equal((await checkRenderService(preflightArgs(flaky.impl))).autoDeploy, 'no');
});

test('preflight verifies service identity, repository and branch', async () => {
  const none = fakeFetch({});
  await assert.rejects(
    checkRenderService(preflightArgs(none.impl, { serviceId: 'srv-other' })),
    /does not match the pinned production service srv-expected/,
  );
  assert.equal(none.calls.length, 0, 'a mismatched id is rejected before any API call');

  for (const [body, re] of [
    [{ ...serviceBody, id: 'srv-other' }, /different service id/],
    [{ ...serviceBody, repo: 'https://github.com/someone/else' }, /is built from .*someone\/else/],
    [{ ...serviceBody, repo: undefined }, /reports no repository/],
    [{ ...serviceBody, branch: 'develop' }, /tracks branch develop, expected main/],
    [{ ...serviceBody, branch: undefined }, /tracks branch \(none\)/],
  ]) {
    await assert.rejects(checkRenderService(preflightArgs(serviceRoute(json(200, body)).impl)), re);
  }

  const sameRepo = serviceRoute(json(200, { ...serviceBody, repo: `${REPO.toUpperCase()}.git/` }));
  assert.equal((await checkRenderService(preflightArgs(sameRepo.impl))).id, SERVICE);
  assert.equal(normalizeRepo('git@github.com:A/B.git'), 'github.com/a/b');
});

test('follow-up poll applies the same fail-closed service check', async () => {
  const f = fakeFetch({
    [`/services/${SERVICE}`]: [json(200, { ...serviceBody, autoDeploy: 'yes' })],
    [`/services/${SERVICE}/deploys/dep-new`]: [deploy('dep-new', 'live')],
  });
  await assert.rejects(waitForRenderDeploy(renderArgs(f.impl, EXPECTED)), /Auto-Deploy is ON/);
  assert.ok(!f.calls.some((c) => c.url.includes('/deploys/')));
});

test('render CLI never fires the hook unless the service preflight passes', async () => {
  for (const [body, re] of [
    [{ ...serviceBody, autoDeploy: 'yes' }, /Auto-Deploy is ON/],
    [{ ...serviceBody, autoDeploy: undefined }, /unknown \(missing\)/],
    [{ ...serviceBody, branch: 'develop' }, /tracks branch develop/],
  ]) {
    const lines = [];
    const f = fakeFetch({
      [`/services/${SERVICE}`]: [json(200, body)],
      '/deploy/': [json(200, { deploy: { id: 'dep-new' } })],
    });
    const code = await main(['render'], RENDER_ENV, {
      fetchImpl: f.impl,
      out: (m) => lines.push(m),
      err: (m) => lines.push(m),
    });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), re);
    assert.ok(!f.calls.some((c) => c.url.includes('/deploy/')), 'hook never POSTed');
  }
  // Pinned id mismatch: nothing is called at all.
  const f = fakeFetch({});
  const code = await main(
    ['render'],
    { ...RENDER_ENV, RENDER_SERVICE_ID_PRODUCTION: 'srv-other' },
    { fetchImpl: f.impl, out: () => {}, err: () => {} },
  );
  assert.equal(code, 1);
  assert.equal(f.calls.length, 0);
});

test('render-preflight CLI: OK line on success, sanitized ::error:: on failure, missing env named', async () => {
  const run = async (routes, env = {}) => {
    const lines = [];
    const f = fakeFetch(routes);
    const code = await main(
      ['render-preflight'],
      { ...RENDER_ENV, ...env },
      { fetchImpl: f.impl, out: (m) => lines.push(m), err: (m) => lines.push(m) },
    );
    return { code, text: lines.join('\n'), calls: f.calls };
  };
  const ok = await run({ [`/services/${SERVICE}`]: [service] });
  assert.equal(ok.code, 0);
  assert.match(ok.text, /Render service srv-expected .*autoDeploy=no\. OK/);
  assert.ok(!ok.calls.some((c) => c.url.includes('/deploy/')), 'preflight never triggers a deploy');

  const on = await run({
    [`/services/${SERVICE}`]: [json(200, { ...serviceBody, autoDeploy: 'yes' })],
  });
  assert.equal(on.code, 1);
  assert.match(on.text, /^::error::Render Auto-Deploy is ON/m);

  // Unauthorized: fails at once (no real retry sleeps), and the key never appears.
  const denied = await run({
    [`/services/${SERVICE}`]: [json(401, { message: `invalid key ${API_KEY}` })],
  });
  assert.equal(denied.code, 1);
  assert.match(denied.text, /::error::Render service lookup: HTTP 401/);
  assert.ok(!denied.text.includes(API_KEY));

  const missing = await run({}, { RENDER_EXPECTED_SERVICE_ID: '' });
  assert.equal(missing.code, 1);
  assert.match(missing.text, /missing required environment: RENDER_EXPECTED_SERVICE_ID/);
  assert.equal(missing.calls.length, 0);
});

test('pollUntil rethrows non-transient errors as-is', async () => {
  const clock = fakeClock();
  await assert.rejects(
    pollUntil({
      label: 'x',
      intervalMs: 1,
      timeoutMs: 10,
      now: clock.now,
      sleep: clock.sleep,
      check: async () => {
        throw new RangeError('boom');
      },
    }),
    RangeError,
  );
});

// ------------------------------------------------------------- web mode ---

test('web mode follows git.deploymentEnabled for main', () => {
  assert.equal(webDeployMode(null), 'git');
  assert.equal(webDeployMode('{}'), 'git');
  assert.equal(webDeployMode('{"git":{"deploymentEnabled":true}}'), 'git');
  assert.equal(webDeployMode('{"git":{"deploymentEnabled":{"staging":false}}}'), 'git');
  assert.equal(webDeployMode('{"git":{"deploymentEnabled":{"main":true}}}'), 'git');
  assert.equal(webDeployMode('{"git":{"deploymentEnabled":{"main":false}}}'), 'workflow');
  assert.equal(webDeployMode('{"git":{"deploymentEnabled":false}}'), 'workflow');
  assert.throws(() => webDeployMode('{"git":{"deploymentEnabled":{"ma*":false}}}'), /glob keys/);
  assert.throws(
    () => webDeployMode('{"git":{"deploymentEnabled":{"main":"no"}}}'),
    /must be a boolean/,
  );
  assert.throws(() => webDeployMode('{nope'), /not valid JSON/);
});

// --------------------------------------------------------------- vercel ---

const PROJECT = 'prj_pinned';
const TEAM = 'team_pinned';
const DOMAINS = ['example.com', 'www.example.com'];
const alias = (deploymentId, projectId = PROJECT) =>
  json(200, { alias: 'x', deploymentId, projectId, uid: 'u' });
const vdep = (id, sha, readyState = 'READY', target = 'production', projectId = PROJECT) =>
  json(200, {
    id,
    readyState,
    target,
    projectId,
    source: 'git',
    meta: sha ? { githubCommitSha: sha } : {},
  });
/** A CLI (workflow-published) deployment tagged with --meta releaseSha. */
const cdep = (id, releaseSha, over = {}) =>
  json(200, {
    id,
    readyState: 'READY',
    target: 'production',
    projectId: PROJECT,
    source: 'cli',
    meta: releaseSha ? { releaseSha } : {},
    ...over,
  });

function vercelArgs(fetchImpl, over = {}) {
  const clock = fakeClock();
  return {
    token: VERCEL_TOKEN,
    teamId: TEAM,
    projectId: PROJECT,
    domains: DOMAINS,
    sha: SHA,
    fetchImpl,
    intervalMs: 10_000,
    timeoutMs: 60_000,
    maxConsecutiveErrors: 3,
    now: clock.now,
    sleep: clock.sleep,
    ...over,
  };
}

test('git mode: the previous production deployment does not satisfy; the new SHA does', async () => {
  const f = fakeFetch({
    '/v4/aliases/example.com': [alias('dpl_old'), alias('dpl_new')],
    '/v4/aliases/www.example.com': [alias('dpl_old'), alias('dpl_new')],
    '/v13/deployments/dpl_old': [vdep('dpl_old', OLD_SHA)],
    '/v13/deployments/dpl_new': [vdep('dpl_new', SHA)],
  });
  const r = await waitForVercelProduction(vercelArgs(f.impl));
  assert.deepEqual(r, { id: 'dpl_new', sha: SHA });
});

test('vercel: split aliases, not-ready, wrong project/target, and timeout', async () => {
  const split = fakeFetch({
    '/v4/aliases/example.com': [alias('dpl_new')],
    '/v4/aliases/www.example.com': [alias('dpl_old')],
  });
  await assert.rejects(
    waitForVercelProduction(vercelArgs(split.impl)),
    /timed out.*different deployments/,
  );

  const building = fakeFetch({
    '/v4/aliases/': [alias('dpl_new')],
    '/v13/deployments/dpl_new': [vdep('dpl_new', SHA, 'BUILDING'), vdep('dpl_new', SHA)],
  });
  assert.equal((await waitForVercelProduction(vercelArgs(building.impl))).id, 'dpl_new');

  const foreign = fakeFetch({ '/v4/aliases/': [alias('dpl_x', 'prj_other')] });
  await assert.rejects(waitForVercelProduction(vercelArgs(foreign.impl)), /another project/);

  const preview = fakeFetch({
    '/v4/aliases/': [alias('dpl_new')],
    '/v13/deployments/dpl_new': [vdep('dpl_new', SHA, 'READY', 'preview')],
  });
  await assert.rejects(waitForVercelProduction(vercelArgs(preview.impl)), /not production/);
});

test('workflow mode: aliases must reach our own deployment id; a contradicting SHA fails', async () => {
  const f = fakeFetch({
    '/v4/aliases/': [alias('dpl_prev'), alias('dpl_prev'), alias('dpl_ours')],
    // Even a READY production deployment of the same SHA is not ours.
    '/v13/deployments/dpl_prev': [vdep('dpl_prev', SHA)],
    '/v13/deployments/dpl_ours': [cdep('dpl_ours', SHA)],
  });
  const r = await waitForVercelProduction(vercelArgs(f.impl, { deploymentId: 'dpl_ours' }));
  assert.equal(r.id, 'dpl_ours');
  assert.ok(
    !f.calls.some((c) => c.url.includes('/v13/deployments/dpl_prev')),
    'the previous deployment is never accepted',
  );

  const mismatch = fakeFetch({
    '/v4/aliases/': [alias('dpl_ours')],
    '/v13/deployments/dpl_ours': [
      cdep('dpl_ours', SHA, { meta: { releaseSha: SHA, githubCommitSha: OLD_SHA } }),
    ],
  });
  await assert.rejects(
    waitForVercelProduction(vercelArgs(mismatch.impl, { deploymentId: 'dpl_ours' })),
    /records commit 0000000/,
  );
});

test('workflow mode: our id must be a cli deployment tagged with this release SHA', async () => {
  const cases = [
    [vdep('dpl_ours', SHA), /source is git, not cli/],
    [cdep('dpl_ours', undefined), /releaseSha is missing/],
    [cdep('dpl_ours', OLD_SHA), /releaseSha is 0000000/],
  ];
  for (const [dep, err] of cases) {
    const f = fakeFetch({
      '/v4/aliases/': [alias('dpl_ours')],
      '/v13/deployments/dpl_ours': [dep],
    });
    await assert.rejects(
      waitForVercelProduction(vercelArgs(f.impl, { deploymentId: 'dpl_ours' })),
      err,
    );
  }
});

test('parseVercelDeployOutput: both CLI JSON shapes, a bare URL, and failures', () => {
  const dep = { id: 'dpl_Abc123', url: 'https://x-abc.vercel.app', target: 'production' };
  assert.deepEqual(parseVercelDeployOutput(JSON.stringify(dep, null, 2)), { id: 'dpl_Abc123' });
  assert.deepEqual(
    parseVercelDeployOutput(JSON.stringify({ status: 'ok', deployment: dep, next: [] })),
    { id: 'dpl_Abc123' },
  );
  assert.deepEqual(parseVercelDeployOutput('https://x-abc.vercel.app\n'), {
    url: 'https://x-abc.vercel.app',
  });

  const bad = [
    ['', /printed nothing/],
    ['https://a.vercel.app\nhttps://b.vercel.app', /neither JSON nor a single/],
    ['Deployed to https://a.vercel.app', /neither JSON nor a single/],
    ['https://evil.example.com', /neither JSON nor a single/],
    ['[]', /not an object/],
    [
      JSON.stringify({ status: 'error', reason: 'upload_failed' }),
      /reported error \(upload_failed\)/,
    ],
    [JSON.stringify({ ...dep, error: { name: 'CHECKS_FAILED' } }), /reported CHECKS_FAILED/],
    [JSON.stringify({ url: dep.url, target: 'production' }), /no deployment id/],
    [JSON.stringify({ ...dep, id: 'dpl_x; rm -rf' }), /no deployment id/],
    [JSON.stringify({ ...dep, target: 'preview' }), /preview deployment, not production/],
    [JSON.stringify({ ...dep, target: null }), /untargeted deployment/],
  ];
  for (const [text, err] of bad) assert.throws(() => parseVercelDeployOutput(text), err, text);
});

test('vercel-staged CLI accepts only our READY production build of this SHA', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'vstaged-'));
  const env = { VERCEL_TOKEN, VERCEL_ORG_ID: TEAM, VERCEL_PROJECT_ID: PROJECT, EXPECTED_SHA: SHA };
  let n = 0;
  const run = async (stdout, routes = {}) => {
    const file = join(dir, `${n++}.out`);
    writeFileSync(file, stdout);
    const lines = [];
    const f = fakeFetch(routes);
    const code = await main(['vercel-staged', file], env, {
      fetchImpl: f.impl,
      out: (m) => lines.push(m),
      err: (m) => lines.push(m),
    });
    return { code, text: lines.join('\n'), calls: f.calls };
  };
  const cliOut = (id) => JSON.stringify({ status: 'ok', deployment: { id, target: 'production' } });

  const ok = await run(cliOut('dpl_Ours1'), {
    '/v13/deployments/dpl_Ours1': [cdep('dpl_Ours1', SHA)],
  });
  assert.deepEqual([ok.code, ok.text], [0, 'dpl_Ours1']);
  assert.ok(ok.calls[0].url.includes(`teamId=${TEAM}`));

  const viaUrl = await run('https://x-abc.vercel.app', {
    '/v13/deployments/x-abc.vercel.app': [json(200, { id: 'dpl_Ours2' })],
    '/v13/deployments/dpl_Ours2': [cdep('dpl_Ours2', SHA)],
  });
  assert.deepEqual([viaUrl.code, viaUrl.text], [0, 'dpl_Ours2']);

  const failures = [
    [cdep('dpl_X', SHA, { readyState: 'ERROR' }), /is ERROR, not READY/],
    [cdep('dpl_X', OLD_SHA), /releaseSha is 0000000/],
    [vdep('dpl_X', SHA), /source is git, not cli/],
    [cdep('dpl_X', SHA, { projectId: 'prj_other' }), /not in the pinned project/],
    [cdep('dpl_X', SHA, { target: 'preview' }), /target is preview/],
    [cdep('dpl_Other', SHA), /lookup returned dpl_Other/],
  ];
  for (const [dep, err] of failures) {
    const r = await run(cliOut('dpl_X'), { '/v13/deployments/dpl_X': [dep] });
    assert.equal(r.code, 1, String(err));
    assert.match(r.text, err);
  }

  const denied = await run('https://x-abc.vercel.app', {
    '/v13/deployments/': [json(403, { error: { message: `bad ${VERCEL_TOKEN}` } })],
  });
  assert.equal(denied.code, 1);
  assert.ok(!denied.text.includes(VERCEL_TOKEN));

  const bad = await run('not a deployment');
  assert.equal(bad.code, 1);
  assert.match(bad.text, /::error::vercel deploy output is neither JSON/);
  assert.equal(bad.calls.length, 0);
});

test('promote: re-checks our READY build, POSTs the promote API once, no retry', async () => {
  const promoteArgs = (fetchImpl) => ({
    token: VERCEL_TOKEN,
    teamId: TEAM,
    projectId: PROJECT,
    sha: SHA,
    deploymentId: 'dpl_Ours',
    fetchImpl,
  });
  const promotePath = `/v10/projects/${PROJECT}/promote/dpl_Ours`;

  const ok = fakeFetch({
    '/v13/deployments/dpl_Ours': [cdep('dpl_Ours', SHA)],
    [promotePath]: [json(201, {})],
  });
  assert.equal(await promoteVercelDeployment(promoteArgs(ok.impl)), 'promoted');
  const post = ok.calls.find((c) => c.url.includes(promotePath));
  assert.equal(post.init.method, 'POST');
  assert.ok(post.url.includes(`teamId=${TEAM}`));
  assert.equal(post.init.headers.Authorization, `Bearer ${VERCEL_TOKEN}`);
  assert.ok(!post.url.includes(VERCEL_TOKEN));

  const queued = fakeFetch({
    '/v13/deployments/dpl_Ours': [cdep('dpl_Ours', SHA)],
    [promotePath]: [json(202, {})],
  });
  assert.equal(await promoteVercelDeployment(promoteArgs(queued.impl)), 'queued');

  // Anything that is not our READY production build is never promoted.
  for (const [dep, err] of [
    [cdep('dpl_Ours', SHA, { readyState: 'BUILDING' }), /is BUILDING, not READY/],
    [cdep('dpl_Ours', OLD_SHA), /releaseSha is 0000000/],
    [vdep('dpl_Ours', SHA), /source is git, not cli/],
    [cdep('dpl_Ours', SHA, { target: 'preview' }), /target is preview/],
    [cdep('dpl_Other', SHA), /lookup returned dpl_Other/],
  ]) {
    const f = fakeFetch({ '/v13/deployments/dpl_Ours': [dep], [promotePath]: [json(201, {})] });
    await assert.rejects(promoteVercelDeployment(promoteArgs(f.impl)), err);
    assert.ok(!f.calls.some((c) => c.url.includes('/promote/')), 'no promote request');
  }

  // Rejected or lost: fail once, never re-POST.
  for (const [resp, err] of [
    [json(409, {}), /HTTP 409/],
    [json(503, {}), /HTTP 503/],
    [
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
      /not retried/,
    ],
  ]) {
    const f = fakeFetch({
      '/v13/deployments/dpl_Ours': [cdep('dpl_Ours', SHA)],
      [promotePath]: [resp],
    });
    await assert.rejects(promoteVercelDeployment(promoteArgs(f.impl)), err);
    assert.equal(f.calls.filter((c) => c.url.includes('/promote/')).length, 1);
  }
});

test('vercel-promote CLI requires the deployment id and never prints the token', async () => {
  const env = {
    VERCEL_TOKEN,
    VERCEL_ORG_ID: TEAM,
    VERCEL_PROJECT_ID: PROJECT,
    EXPECTED_SHA: SHA,
    VERCEL_DEPLOYMENT_ID: 'dpl_Ours',
  };
  const run = async (routes, over = {}) => {
    const lines = [];
    const f = fakeFetch(routes);
    const code = await main(
      ['vercel-promote'],
      { ...env, ...over },
      {
        fetchImpl: f.impl,
        out: (m) => lines.push(m),
        err: (m) => lines.push(m),
      },
    );
    return { code, text: lines.join('\n'), calls: f.calls };
  };
  const ok = await run({
    '/v13/deployments/dpl_Ours': [cdep('dpl_Ours', SHA)],
    '/promote/dpl_Ours': [json(201, {})],
  });
  assert.equal(ok.code, 0);
  assert.match(
    ok.text,
    /Vercel promote of dpl_Ours \(1111111111111111111111111111111111111111\) promoted/,
  );

  const missing = await run({}, { VERCEL_DEPLOYMENT_ID: '' });
  assert.equal(missing.code, 1);
  assert.match(missing.text, /missing required environment: VERCEL_DEPLOYMENT_ID/);
  assert.equal(missing.calls.length, 0);

  const denied = await run({
    '/v13/deployments/': [json(403, { error: { message: `bad ${VERCEL_TOKEN}` } })],
  });
  assert.equal(denied.code, 1);
  assert.ok(!denied.text.includes(VERCEL_TOKEN));
});

// ------------------------------------------------------- secret hygiene ---

test('sanitize scrubs every secret occurrence', () => {
  assert.equal(sanitize(`a ${API_KEY} b ${API_KEY}`, [API_KEY, '']), 'a *** b ***');
});

test('CLI output never contains the hook URL, hook key or API key — success and failure', async () => {
  const run = async (routes, env = {}) => {
    const lines = [];
    const f = fakeFetch(routes);
    const code = await main(
      ['render'],
      { ...RENDER_ENV, ...env },
      { fetchImpl: f.impl, out: (m) => lines.push(m), err: (m) => lines.push(m) },
    );
    return { code, text: lines.join('\n'), calls: f.calls };
  };
  const leaks = (text) => ['HOOKSECRETkey', API_KEY, HOOK].filter((s) => text.includes(s));

  // A hostile error path: the network error message itself contains the hook URL.
  const failed = await run({
    [`/services/${SERVICE}`]: [service],
    '/deploy/': [
      Object.assign(new TypeError(`fetch failed ${HOOK}`), { cause: { code: 'ECONNRESET' } }),
    ],
  });
  assert.equal(failed.code, 1);
  assert.match(failed.text, /::error::Render deploy hook: network error \(ECONNRESET\)/);
  assert.deepEqual(leaks(failed.text), []);

  // A failed deploy after a successful trigger.
  const bad = await run({
    '/deploy/': [json(200, { deploy: { id: 'dep-new' } })],
    [`/services/${SERVICE}`]: [service],
    [`/services/${SERVICE}/deploys/dep-new`]: [deploy('dep-new', 'build_failed')],
  });
  assert.equal(bad.code, 1);
  assert.match(bad.text, /ended as build_failed/);
  assert.deepEqual(leaks(bad.text), []);
  const statusCall = bad.calls.find((c) => c.url.includes('/deploys/dep-new'));
  assert.equal(
    statusCall.init.headers.Authorization,
    `Bearer ${API_KEY}`,
    'key goes in the header, not the URL',
  );
  assert.ok(!statusCall.url.includes(API_KEY));

  // Missing credentials fail clearly and name only the variables.
  const missing = await run({}, { RENDER_API_KEY: '' });
  assert.equal(missing.code, 1);
  assert.match(missing.text, /missing required environment: RENDER_API_KEY/);
  assert.equal(missing.calls.length, 0, 'nothing is triggered without every credential');
});

test('vercel-verify CLI never prints the token', async () => {
  const lines = [];
  const f = fakeFetch({
    '/v4/aliases/': [json(403, { error: { message: `bad token ${VERCEL_TOKEN}` } })],
  });
  const code = await main(
    ['vercel-verify'],
    {
      VERCEL_TOKEN,
      VERCEL_ORG_ID: TEAM,
      VERCEL_PROJECT_ID: PROJECT,
      EXPECTED_SHA: SHA,
      VERCEL_PRODUCTION_DOMAINS: DOMAINS.join(','),
    },
    { fetchImpl: f.impl, out: (m) => lines.push(m), err: (m) => lines.push(m) },
  );
  assert.equal(code, 1);
  assert.ok(!lines.join('\n').includes(VERCEL_TOKEN));
  assert.match(lines.join('\n'), /HTTP 403/);
});
