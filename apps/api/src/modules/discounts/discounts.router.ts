import { Router } from 'express';
import { discountsService } from './discounts.service.js';

const router: Router = Router();

// TODO(Phase 1+): implement routes for the discounts module.
// Every route must: validate its payload with Zod, run through
// authenticate + authorize (+ branch-guard where applicable) middleware,
// and call discountsService rather than touching Prisma directly.

void discountsService;

export { router as discountsRouter };
