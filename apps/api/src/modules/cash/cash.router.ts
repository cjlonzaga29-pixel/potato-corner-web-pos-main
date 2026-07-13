import { Router } from 'express';
import { cashService } from './cash.service.js';

const router: Router = Router();

// TODO(Phase 1+): implement routes for the cash module.
// Every route must: validate its payload with Zod, run through
// authenticate + authorize (+ branch-guard where applicable) middleware,
// and call cashService rather than touching Prisma directly.

void cashService;

export { router as cashRouter };
