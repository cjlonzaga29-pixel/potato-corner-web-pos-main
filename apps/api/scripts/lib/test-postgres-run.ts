// POS-PERF-P62 — exit-status logic for scripts/with-test-postgres.ts, kept
// separate so it can be tested without starting Postgres.
//
// Why this exists: `embedded-postgres` registers `async-exit-hook`, whose
// `beforeExit` handler calls `process.exit(0)`. The old script set
// `process.exitCode = 1` on failure and let the event loop drain, so the hook
// replaced every failure with 0 (reproduced: a child exiting 7 gave 0). The
// runner now computes one exit code and calls `process.exit(code)` itself,
// before `beforeExit` can fire.
import { spawn } from 'node:child_process';
import os from 'node:os';
import readline from 'node:readline';

export interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface Cluster {
  initialise(): Promise<unknown>;
  start(): Promise<unknown>;
  createDatabase(name: string): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface RunOptions {
  cluster: Cluster;
  dbName: string;
  /** Applies migrations; throws on failure. */
  migrate: () => void | Promise<void>;
  /** Runs the wrapped command; resolves with how it ended. */
  runCommand: () => Promise<ChildOutcome>;
  log?: (line: string) => void;
}

/** Exit code a wrapped command's ending maps to. Only a clean 0 is success. */
export function exitCodeFor(outcome: ChildOutcome): number {
  if (outcome.code !== null) return outcome.code;
  if (outcome.signal) {
    const n = os.constants.signals[outcome.signal];
    return typeof n === 'number' ? 128 + n : 1;
  }
  return 1;
}

/**
 * Removing the non-persistent data dir after Postgres has stopped often fails
 * on Windows (a handle is released a moment late). That leaves a temp folder,
 * not a running server, so it is reported but doesn't fail a passing run.
 * Any other stop failure means Postgres may still be running, and does.
 */
export function isDataDirRemovalError(error: unknown): boolean {
  const e = error as { code?: string; syscall?: string } | null;
  return !!e && (e.syscall === 'rmdir' || e.syscall === 'rm' || e.syscall === 'unlink')
    && ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(e.code ?? '');
}

/** Runs setup, the command and cleanup, and returns the process exit code. */
export async function runWithCluster(opts: RunOptions): Promise<number> {
  const log = opts.log ?? ((line: string) => console.log(line));
  let code: number;
  let started = false;
  try {
    await opts.cluster.initialise();
    started = true; // start() may leave a process behind even if it rejects
    await opts.cluster.start();
    await opts.cluster.createDatabase(opts.dbName);
    log('[with-test-postgres] applying migrations (prisma migrate deploy)');
    await opts.migrate();
    const outcome = await opts.runCommand();
    code = exitCodeFor(outcome);
    log(`[with-test-postgres] command ended: code=${outcome.code} signal=${outcome.signal} -> exit ${code}`);
  } catch (error) {
    log(`[with-test-postgres] setup failed: ${(error as Error)?.message ?? String(error)}`);
    code = 1;
  }

  if (started) {
    log('[with-test-postgres] stopping embedded Postgres');
    try {
      await opts.cluster.stop();
    } catch (error) {
      if (isDataDirRemovalError(error)) {
        log(`[with-test-postgres] cleanup left the data dir behind (not fatal): ${(error as Error).message}`);
      } else {
        log(`[with-test-postgres] cleanup failed, Postgres may still be running: ${(error as Error)?.message ?? String(error)}`);
        // Never turns a failure into success; only a passing run is changed.
        if (code === 0) code = 1;
      }
    }
  }
  return code;
}

/**
 * Ends the process with the run's code. Calling process.exit explicitly is
 * the point: letting the loop drain would fire async-exit-hook's
 * `beforeExit` handler, which exits 0.
 */
export function exitProcessWith(run: Promise<number>): void {
  run.then(
    (code) => {
      console.log(`[with-test-postgres] exit ${code}`);
      process.exit(code);
    },
    (error) => {
      console.error('[with-test-postgres] failed:', error);
      process.exit(1);
    },
  );
}

/**
 * Runs `cmd` with stdout/stderr drained line by line rather than inherited.
 * The non-production Prisma client logs every query; piping that straight
 * through was observed to stall the child under Windows/Git Bash (pipe
 * backpressure). `prisma:query` lines are dropped. Signals sent to this
 * process are forwarded to the child. Resolves with how the child ended;
 * rejects only if it could not be started.
 */
export function runFiltered(cmd: string, env: NodeJS.ProcessEnv): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    console.log(`$ ${cmd}`);
    const child = spawn(cmd, { env, shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    const forward = (signal: NodeJS.Signals) => () => { child.kill(signal); };
    const handlers = (['SIGINT', 'SIGTERM'] as const).map((s) => [s, forward(s)] as const);
    for (const [s, h] of handlers) process.on(s, h);
    const done = () => { for (const [s, h] of handlers) process.off(s, h); };
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream }).on('line', (line) => {
        if (/^prisma:query/.test(line)) return;
        console.log(line);
      });
    }
    // 'close' (not 'exit') so the output is fully drained before we report.
    child.on('close', (code, signal) => { done(); resolve({ code, signal }); });
    child.on('error', (error) => { done(); reject(error); });
  });
}
