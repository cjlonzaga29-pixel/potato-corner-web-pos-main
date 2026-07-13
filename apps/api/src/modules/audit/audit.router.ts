import { Router } from 'express';
import { auditService } from './audit.service.js';

const router: Router = Router();

// TODO(Phase 1+): implement routes for the audit module.
// Every route must: validate its payload with Zod, run through
// authenticate + authorize (+ branch-guard where applicable) middleware,
// and call auditService rather than touching Prisma directly.

void auditService;

export { router as auditRouter };
