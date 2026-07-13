import { prisma } from '../../lib/prisma.js';

/**
 * Attendance repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const attendanceRepository = {
  // TODO(Phase 1+): implement queries for the attendance module.
};

// Referenced to avoid an unused-import lint error until real queries land.
void prisma;
