import { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';

/**
 * Singleton Prisma client. Never instantiate PrismaClient anywhere else —
 * every module's repository imports this instance.
 */
export const prisma = new PrismaClient({
  log: config.isProduction ? ['error', 'warn'] : ['query', 'error', 'warn'],
});

async function shutdown(): Promise<void> {
  await prisma.$disconnect();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
