// POS-PERF-P62 — the disposable-Postgres runner must report failures.
// Regression for: with-test-postgres.ts exited 0 when vitest failed, because
// embedded-postgres's async-exit-hook calls process.exit(0) on beforeExit.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeFor, isDataDirRemovalError, runWithCluster, type Cluster } from './test-postgres-run';

const fixture = path.join(__dirname, 'test-postgres-run.exit-fixture.ts');
const tsxCli = require.resolve('tsx/cli');

function runFixture(scenario: string) {
  const r = spawnSync(process.execPath, [tsxCli, fixture, scenario], { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function cluster(overrides: Partial<Cluster> = {}): Cluster & { stopped: number } {
  const c = {
    stopped: 0,
    initialise: async () => {},
    start: async () => {},
    createDatabase: async () => {},
    stop: async () => { c.stopped++; },
    ...overrides,
  };
  return c;
}

const quiet = () => {};

describe('exitCodeFor', () => {
  it('passes the child code through and maps signals to 128+n', () => {
    expect(exitCodeFor({ code: 0, signal: null })).toBe(0);
    expect(exitCodeFor({ code: 7, signal: null })).toBe(7);
    expect(exitCodeFor({ code: null, signal: 'SIGTERM' })).toBe(143);
    expect(exitCodeFor({ code: null, signal: null })).toBe(1);
  });
});

describe('runWithCluster', () => {
  it('returns the failing command code and still stops Postgres', async () => {
    const c = cluster();
    const code = await runWithCluster({ cluster: c, dbName: 'x', migrate: () => {}, runCommand: async () => ({ code: 3, signal: null }), log: quiet });
    expect(code).toBe(3);
    expect(c.stopped).toBe(1);
  });

  it('fails when migrations fail, without running the command', async () => {
    let ran = false;
    const code = await runWithCluster({
      cluster: cluster(), dbName: 'x', log: quiet,
      migrate: () => { throw new Error('migrate failed'); },
      runCommand: async () => { ran = true; return { code: 0, signal: null }; },
    });
    expect(code).toBe(1);
    expect(ran).toBe(false);
  });

  it('a cleanup failure never turns a test failure into success', async () => {
    const code = await runWithCluster({
      cluster: cluster({ stop: async () => { throw new Error('stop failed'); } }), dbName: 'x', log: quiet,
      migrate: () => {}, runCommand: async () => ({ code: 5, signal: null }),
    });
    expect(code).toBe(5);
  });

  it('fails a passing run when Postgres could not be stopped, but not for a leftover data dir', async () => {
    const stopFail = await runWithCluster({
      cluster: cluster({ stop: async () => { throw new Error('stop failed'); } }), dbName: 'x', log: quiet,
      migrate: () => {}, runCommand: async () => ({ code: 0, signal: null }),
    });
    expect(stopFail).toBe(1);
    const busy = Object.assign(new Error('EBUSY'), { code: 'EBUSY', syscall: 'rmdir' });
    expect(isDataDirRemovalError(busy)).toBe(true);
    const leftover = await runWithCluster({
      cluster: cluster({ stop: async () => { throw busy; } }), dbName: 'x', log: quiet,
      migrate: () => {}, runCommand: async () => ({ code: 0, signal: null }),
    });
    expect(leftover).toBe(0);
  });
});

// Real child processes with embedded-postgres's real exit hook registered.
describe('process exit status with the embedded-postgres exit hook loaded', () => {
  it.each([
    ['pass', 0],
    ['fail', 7],
    ['setup', 1],
    ['stop-busy', 0],
    ['stop-fail', 1],
    ['fail-stop-fail', 7],
  ])('%s exits %i', (scenario, expected) => {
    const r = runFixture(scenario);
    expect(r.status, r.output).toBe(expected);
  }, 60_000);

  it('a child killed by a signal exits nonzero', () => {
    const r = runFixture('signal');
    expect(r.status, r.output).not.toBe(0);
    expect(r.status, r.output).not.toBeNull();
  }, 60_000);
});
