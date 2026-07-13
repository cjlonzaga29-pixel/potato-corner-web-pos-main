import { Router } from 'express';
import { reportsService } from './reports.service.js';

const router: Router = Router();

// TODO(Phase 1+): implement routes for the reports module.
// Every route must: validate its payload with Zod, run through
// authenticate + authorize (+ branch-guard where applicable) middleware,
// and call reportsService rather than touching Prisma directly.

void reportsService;

export { router as reportsRouter };
