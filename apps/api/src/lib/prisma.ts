import { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';
import { immutabilityMiddleware } from './prisma-immutability.js';

/**
 * Singleton Prisma client. Never instantiate PrismaClient anywhere else —
 * every module's repository imports this instance.
 */
export const prisma = new PrismaClient({
  log: config.isProduction ? ['error', 'warn'] : ['query', 'error', 'warn'],
});

// CR-004 immutability guard (prisma-immutability.ts) — applies inside
// prisma.$transaction callbacks too, since middleware runs for every query
// regardless of which client (root or `tx`) it was issued through.
prisma.$use(immutabilityMiddleware);

/**
 * Not auto-registered on SIGTERM/SIGINT here — server.ts (the only
 * long-running entry point) owns an explicit, ordered shutdown sequence
 * (stop the inventory deduction worker's poll loop, close the HTTP server,
 * *then* disconnect) and calls this last. Auto-disconnecting from this
 * module in parallel with that sequence would race the worker's in-flight
 * query against the pool being torn down. One-shot scripts don't need this:
 * Prisma's connections close with the process on normal exit.
 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
