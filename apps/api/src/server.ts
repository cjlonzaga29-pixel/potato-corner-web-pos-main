import 'dotenv/config';
import { createServer } from 'node:http';
import * as Sentry from '@sentry/node';
import { config } from './config/index.js';
import { app } from './app.js';
import { createSocketServer } from './socket/socket.server.js';
import { redis } from './lib/redis.js';
import { scheduleNightlyFraudScan } from './queues/fraud.queue.js';
import { scheduleNightlyEodSummary } from './queues/eod.queue.js';

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
 * Background infrastructure (Redis pub/sub for the Socket.io adapter,
 * BullMQ workers) can reject a promise outside any request's try/catch —
 * e.g. the Socket.io Redis adapter's internal SUBSCRIBE command rejecting
 * because Redis is unreachable. Node's default behavior for an unhandled
 * rejection or uncaught exception is to crash the process; that's correct
 * for a bug in request-handling code, but wrong for a transient
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

/**
 * `redis` is configured with `maxRetriesPerRequest: null` (required by
 * BullMQ workers — see lib/redis.ts), which means a command like `.ping()`
 * never rejects when Redis is unreachable; it just retries forever. This
 * check needs its own timeout so an unreachable Redis doesn't block server
 * startup indefinitely.
 */
async function checkRedisConnection(timeoutMs = 3000): Promise<boolean> {
  return Promise.race([
    redis.ping().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function start(): Promise<void> {
  const redisOk = await checkRedisConnection();
  if (redisOk) {
    console.log('Redis connection verified.');
  } else {
    console.error('Redis is unreachable at startup — continuing, but sessions/rate-limiting/queues will not work.');
  }

  if (redisOk) {
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
  }

  const httpServer = createServer(app);
  createSocketServer(httpServer);

  httpServer.listen(config.port, () => {
    console.log(`API listening on http://localhost:${config.port} [env: ${config.nodeEnv}]`);
  });
}

void start();
