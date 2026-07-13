import { Router } from 'express';
import { fraudService } from './fraud.service.js';

const router: Router = Router();

// TODO(Phase 1+): implement routes for the fraud module.
// Every route must: validate its payload with Zod, run through
// authenticate + authorize (+ branch-guard where applicable) middleware,
// and call fraudService rather than touching Prisma directly.

void fraudService;

export { router as fraudRouter };
