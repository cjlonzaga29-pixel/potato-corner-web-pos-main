import { Router } from 'express';
import { notificationsService } from './notifications.service.js';

const router: Router = Router();

// TODO(Phase 1+): implement routes for the notifications module.
// Every route must: validate its payload with Zod, run through
// authenticate + authorize (+ branch-guard where applicable) middleware,
// and call notificationsService rather than touching Prisma directly.

void notificationsService;

export { router as notificationsRouter };
