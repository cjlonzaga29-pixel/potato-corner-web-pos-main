import { prisma } from '../../lib/prisma.js';

/**
 * Fraud repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const fraudRepository = {
  // TODO(Phase 1+): implement queries for the fraud module.
};

// Referenced to avoid an unused-import lint error until real queries land.
void prisma;
