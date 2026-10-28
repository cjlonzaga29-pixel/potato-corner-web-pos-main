// POS-PERF-P44 — unit tests for the E2E target/write guards. Node's built-in
// runner (no browser, no network): node --test tests/e2e/helpers/guards.node-test.mts
// Named *.node-test.mts so Playwright's default testMatch never collects it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isProductionUrl, resolveIsolatedBaseURL, resolveProductionSmokeBaseURL } from './e2e-target.ts';
import { isAllowedRequest } from './read-only-guard.ts';

const require = createRequire(import.meta.url);
const { assertLocalDatabase } = require('../fixtures/local-db-guard.cjs') as {
  assertLocalDatabase: (env: Record<string, string | undefined>, options: { loadDotenv: boolean }) => void;
};

test('production smoke: no default target', () => {
  assert.throws(() => resolveProductionSmokeBaseURL({}), /must be set explicitly/);
  assert.throws(() => resolveProductionSmokeBaseURL({ PLAYWRIGHT_BASE_URL: '  ' }), /must be set explicitly/);
});

test('production smoke: approved production origins and local rehearsal only', () => {
  assert.equal(resolveProductionSmokeBaseURL({ PLAYWRIGHT_BASE_URL: 'https://www.potatorenovare.com' }), 'https://www.potatorenovare.com');
  assert.equal(resolveProductionSmokeBaseURL({ PLAYWRIGHT_BASE_URL: 'https://potatorenovare.com/' }), 'https://potatorenovare.com');
  assert.equal(resolveProductionSmokeBaseURL({ PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3440' }), 'http://127.0.0.1:3440');
  assert.throws(() => resolveProductionSmokeBaseURL({ PLAYWRIGHT_BASE_URL: 'http://potatorenovare.com' }), /neither an approved/);
  assert.throws(() => resolveProductionSmokeBaseURL({ PLAYWRIGHT_BASE_URL: 'https://evil.example' }), /neither an approved/);
  assert.throws(() => resolveProductionSmokeBaseURL({ PLAYWRIGHT_BASE_URL: 'not a url' }), /not a valid URL/);
});

test('isolated: defaults to localhost', () => {
  assert.equal(resolveIsolatedBaseURL({}), 'http://localhost:3000');
  assert.equal(resolveIsolatedBaseURL({ PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3400' }), 'http://127.0.0.1:3400');
});

test('isolated: production is refused even when "confirmed"', () => {
  for (const url of ['https://potatorenovare.com', 'https://www.potatorenovare.com', 'https://api.potatorenovare.com']) {
    assert.ok(isProductionUrl(url));
    assert.throws(() => resolveIsolatedBaseURL({ PLAYWRIGHT_BASE_URL: url, E2E_ISOLATED_REMOTE_HOST: new URL(url).hostname }), /is production/);
  }
  assert.equal(isProductionUrl('https://notpotatorenovare.com'), false);
});

test('isolated: a remote host needs an exact confirmation', () => {
  const env = { PLAYWRIGHT_BASE_URL: 'https://e2e.example.test' };
  assert.throws(() => resolveIsolatedBaseURL(env), /E2E_ISOLATED_REMOTE_HOST/);
  assert.throws(() => resolveIsolatedBaseURL({ ...env, E2E_ISOLATED_REMOTE_HOST: 'other.example.test' }), /E2E_ISOLATED_REMOTE_HOST/);
  assert.equal(resolveIsolatedBaseURL({ ...env, E2E_ISOLATED_REMOTE_HOST: 'E2E.example.test' }), 'https://e2e.example.test');
});

test('read-only guard: reads and session calls pass, every other write is blocked', () => {
  const base = 'https://www.potatorenovare.com';
  assert.ok(isAllowedRequest('GET', `${base}/api/transactions?limit=5`));
  assert.ok(isAllowedRequest('HEAD', `${base}/admin/dashboard`));
  for (const path of ['/api/auth/login', '/api/auth/refresh', '/api/auth/logout']) assert.ok(isAllowedRequest('POST', `${base}${path}`));
  for (const [method, path] of [
    ['POST', '/api/transactions'],
    ['POST', '/api/attendance/clock-in'],
    ['POST', '/api/auth/pin/login'],
    ['POST', '/api/auth/select-employee'],
    ['POST', '/api/auth/logout-all'],
    ['PATCH', '/api/products/1'],
    ['PUT', '/api/settings'],
    ['DELETE', '/api/expenses/1'],
    ['POST', '/admin/dashboard'],
    ['POST', '/api/auth/login/extra'],
  ] as const) {
    assert.equal(isAllowedRequest(method, `${base}${path}`), false, `${method} ${path}`);
  }
});

test('read-only guard: realtime blocked by default, allowed only on opt-in', () => {
  const socket = 'https://api.example.test/socket.io/?EIO=4&transport=polling';
  assert.equal(isAllowedRequest('GET', socket), false);
  assert.equal(isAllowedRequest('POST', socket), false);
  assert.ok(isAllowedRequest('GET', socket, 'allow'));
  assert.ok(isAllowedRequest('POST', socket, 'allow'));
});

test('direct-database fixtures: local only, values never echoed', () => {
  const local = 'postgresql://u:secret-value@127.0.0.1:5432/p44_verify';
  assert.doesNotThrow(() => assertLocalDatabase({ DATABASE_URL: local, SUPABASE_URL: 'http://localhost:54321' }, { loadDotenv: false }));
  assert.throws(() => assertLocalDatabase({}, { loadDotenv: false }), /DATABASE_URL is not set/);
  for (const name of ['DATABASE_URL', 'DIRECT_URL', 'SUPABASE_URL']) {
    const env = { DATABASE_URL: local, [name]: 'postgresql://u:secret-value@db.remote.example:6543/postgres' };
    assert.throws(
      () => assertLocalDatabase(env, { loadDotenv: false }),
      (err: Error) => err.message.startsWith(`${name} is not local`) && !err.message.includes('secret-value'),
    );
  }
});
