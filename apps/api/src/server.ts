import 'dotenv/config';
import { createServer } from 'node:http';
import * as Sentry from '@sentry/node';
import { config } from './config/index.js';
import { app } from './app.js';
import { posthog } from './lib/posthog.js';
import { createSocketServer } from './socket/socket.server.js';
import { scheduleNightlyFraudScan } from './queues/fraud.queue.js';
import { scheduleNightlyEodSummary } from './queues/eod.queue.js';
import { scheduleEvery } from './lib/daily-scheduler.js';
import { authRepository } from './modules/auth/auth.repository.js';

// Importing `config` above already validated every required env var (it
// fails fast with a clear field-level error if anything is missing) —
// Sentry initializes immediately after, before the HTTP server starts.
Sentry.init({
  dsn: config.sentryDsn,
  environment: config.nodeEnv,
  enabled: Boolean(config.sentryDsn),
  tracesSampleRate: config.isProduction ? 0.1 : 1.0,
});

/**
 * Background infrastructure (BullMQ workers, previously) could reject a
 * promise outside any request's try/catch. Node's default behavior for an
 * unhandled rejection or uncaught exception is to crash the process; that's
 * correct for a bug in request-handling code, but wrong for a transient
 * infrastructure hiccup that shouldn't take the whole API down. Report to
 * Sentry and keep running.
 */
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  Sentry.captureException(reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  Sentry.captureException(error);
});

process.on('SIGINT', async () => {
  await posthog.shutdown();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await posthog.shutdown();
  process.exit(0);
});

async function start(): Promise<void> {
  // Phase 21: no Redis reachability gate — schedulers are in-process
  // setTimeout timers now (see lib/daily-scheduler.ts), not Redis-backed
  // repeatable jobs, so there's nothing here that depends on Redis being up.
  try {
    await scheduleNightlyFraudScan();
    console.log('Nightly fraud detection scan scheduled (23:00 Asia/Manila).');
  } catch (error) {
    console.error('Failed to register the nightly fraud detection scan:', error);
    Sentry.captureException(error);
  }

  try {
    await scheduleNightlyEodSummary();
    console.log('Nightly EOD summary scheduled (23:59 Asia/Manila).');
  } catch (error) {
    console.error('Failed to register the nightly EOD summary:', error);
    Sentry.captureException(error);
  }

  scheduleEvery(60 * 60 * 1000, () => authRepository.pruneRotationCache());
  console.log('Hourly refresh-token rotation cache cleanup scheduled.');

  const httpServer = createServer(app);
  createSocketServer(httpServer);

  httpServer.listen(config.port, () => {
    console.log(`API listening on http://localhost:${config.port} [env: ${config.nodeEnv}]`);
  });
}

void start();
