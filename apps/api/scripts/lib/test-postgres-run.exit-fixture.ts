// Child process for test-postgres-run.test.ts. Importing embedded-postgres
// registers its real async-exit-hook (the cause of the old false exit 0);
// the cluster itself is a stand-in so no Postgres starts. Scenario in argv[2]:
//   pass | fail | signal | setup | stop-busy | stop-fail | fail-stop-fail
import 'embedded-postgres';
import { exitProcessWith, runFiltered, runWithCluster, type Cluster } from './test-postgres-run';

const scenario = process.argv[2] ?? 'pass';

const busy = Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY', syscall: 'rmdir' });
const cluster: Cluster = {
  initialise: async () => {},
  start: async () => { if (scenario === 'setup') throw new Error('pg_ctl failed to start'); },
  createDatabase: async () => {},
  stop: async () => {
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
};

exitProcessWith(runWithCluster({
  cluster,
  dbName: 'pos_test',
  migrate: () => {},
  runCommand: () => runFiltered(commands[scenario] ?? commands.pass, process.env),
}));
