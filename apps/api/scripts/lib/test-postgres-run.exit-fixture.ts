// Child process for test-postgres-run.test.ts. Importing embedded-postgres
// registers its real async-exit-hook (the cause of the old false exit 0);
// the cluster itself is a stand-in so no Postgres starts. Scenario in argv[2]:
//   pass | fail | signal | setup | stop-busy | stop-fail | fail-stop-fail
//   setup-undefined | pass-stop-hang | fail-stop-hang | drain | early-exit-0
// "hang" stops return a promise that never settles and holds no handle, as
// embedded-postgres's stop() does after start() failed on a port conflict.
import 'embedded-postgres';
import { exitProcessWith, runFiltered, runWithCluster, type Cluster } from './test-postgres-run';

const scenario = process.argv[2] ?? 'pass';

const busy = Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY', syscall: 'rmdir' });
const never = () => new Promise<never>(() => {});
const cluster: Cluster = {
  initialise: async () => {},
  start: () => {
    if (scenario === 'setup') return Promise.reject(new Error('pg_ctl failed to start'));
    // embedded-postgres: `this.process.on('close', () => { reject(); })`
    if (scenario === 'setup-undefined') return Promise.reject(undefined);
    return Promise.resolve();
  },
  createDatabase: async () => {},
  stop: async () => {
    if (scenario === 'setup-undefined' || scenario.endsWith('-stop-hang')) return never();
    if (scenario === 'stop-busy') throw busy;
    if (scenario === 'stop-fail' || scenario === 'fail-stop-fail') throw new Error('pg_ctl stop failed');
  },
};

const node = JSON.stringify(process.execPath);
const commands: Record<string, string> = {
  pass: `${node} -e "process.exit(0)"`,
  fail: `${node} -e "process.exit(7)"`,
  'fail-stop-fail': `${node} -e "process.exit(7)"`,
  // The shell's own child kills itself, so the shell reports 128+9 or the
  // platform's equivalent; either way it must not be 0.
  signal: `${node} -e "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000)"`,
  'stop-busy': `${node} -e "process.exit(0)"`,
  'stop-fail': `${node} -e "process.exit(0)"`,
  setup: `${node} -e "process.exit(0)"`,
  'setup-undefined': `${node} -e "process.exit(0)"`,
  'pass-stop-hang': `${node} -e "process.exit(0)"`,
  'fail-stop-hang': `${node} -e "process.exit(7)"`,
};

if (scenario === 'drain') {
  // A run that never settles and keeps nothing alive: the loop drains.
  exitProcessWith(never());
} else if (scenario === 'early-exit-0') {
  // Something else exits 0 while the run is still going.
  exitProcessWith(new Promise<number>((resolve) => { setTimeout(() => resolve(0), 5000); }));
  setTimeout(() => { process.exit(0); }, 50);
} else {

  exitProcessWith(runWithCluster({
    cluster,
    dbName: 'pos_test',
    migrate: () => {},
    runCommand: () => runFiltered(commands[scenario] ?? `${node} -e "process.exit(0)"`, process.env),
    stopTimeoutMs: 500,
  }));
}
