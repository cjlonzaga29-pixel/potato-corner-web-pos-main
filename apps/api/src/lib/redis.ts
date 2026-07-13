import { Redis } from 'ioredis';
import * as Sentry from '@sentry/node';
import { config } from '../config/index.js';

/**
 * Singleton Redis connection, shared by session blacklisting, rate
 * limiting, BullMQ queues, and Socket.io's Redis adapter.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ workers against managed
 * Redis providers like Upstash — without it, BullMQ throws on the first
 * transient connection blip instead of retrying.
 *
 * `commandTimeout` is what actually keeps the API responsive when Redis is
 * unreachable: with `maxRetriesPerRequest: null`, an individual command
 * (rate-limit check, blacklist lookup, a plain `.ping()`) would otherwise
 * never reject — it retries forever, which hangs every request middleware
 * that touches Redis (including the global apiLimiter) indefinitely.
 * `commandTimeout` bounds each command independently of the connection
 * retry strategy, so a down Redis produces fast, visible errors instead of
 * silently wedging the whole API.
 */
export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: null,
  commandTimeout: 5000,
});

// ioredis logs an "Unhandled error event" warning for any client without an
// 'error' listener — including duplicate()'d clients created elsewhere
// (e.g. the Socket.io adapter's pub/sub pair). Errors are logged and sent
// to Sentry, not thrown, since transient connection failures shouldn't
// crash the process.
redis.on('error', (error) => {
  console.error('Redis connection error:', error.message);
  Sentry.captureException(error, { tags: { component: 'redis' } });
});
