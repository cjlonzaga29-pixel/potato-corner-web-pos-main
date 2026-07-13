import { Router } from 'express';
import { attendanceService } from './attendance.service.js';

const router: Router = Router();

// TODO(Phase 1+): implement routes for the attendance module.
// Every route must: validate its payload with Zod, run through
// authenticate + authorize (+ branch-guard where applicable) middleware,
// and call attendanceService rather than touching Prisma directly.

void attendanceService;

export { router as attendanceRouter };
