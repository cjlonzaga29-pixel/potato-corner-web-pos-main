import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { CATALOG_RESOURCE_TYPES } from '@potato-corner/shared';
import { catalogAssignmentService } from './catalog-assignment.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';

const router: Router = Router();

const historyQuerySchema = z.object({
  resource_type: z.enum(CATALOG_RESOURCE_TYPES),
  resource_id: z.uuid(),
});

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

// POS-PERF-P36 — this router is now read-only internal audit history of the
// POS-PERF-P35R manual-assignment era (/unmanaged, /preview, and the POST
// mutation are retired — catalog authority is derived from active branch
// assignments, see catalog-authority.ts). CatalogManagementAssignment rows
// are append-only and never deleted, so this history remains queryable
// indefinitely. Admin-only, matching every other catalog read in this
// module's history.

router.get('/', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const history = await catalogAssignmentService.listHistory(parsed.data.resource_type, parsed.data.resource_id);
    res.status(200).json({ data: { assignments: history }, error: null, meta: null });
  } catch (error) {
    next(error);
  }
});

export { router as catalogAssignmentRouter };
