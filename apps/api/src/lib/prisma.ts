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

async function shutdown(): Promise<void> {
  await prisma.$disconnect();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
