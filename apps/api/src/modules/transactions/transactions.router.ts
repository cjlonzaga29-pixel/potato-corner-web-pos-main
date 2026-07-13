import { Router } from 'express';
import { transactionsService } from './transactions.service.js';

const router: Router = Router();

// TODO(Phase 1+): implement routes for the transactions module.
// Every route must: validate its payload with Zod, run through
// authenticate + authorize (+ branch-guard where applicable) middleware,
// and call transactionsService rather than touching Prisma directly.

void transactionsService;

export { router as transactionsRouter };
