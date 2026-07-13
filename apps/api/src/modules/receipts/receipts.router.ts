import { Router } from 'express';
import { receiptsService } from './receipts.service.js';

const router: Router = Router();

// TODO(Phase 1+): implement routes for the receipts module.
// Every route must: validate its payload with Zod, run through
// authenticate + authorize (+ branch-guard where applicable) middleware,
// and call receiptsService rather than touching Prisma directly.

void receiptsService;

export { router as receiptsRouter };
