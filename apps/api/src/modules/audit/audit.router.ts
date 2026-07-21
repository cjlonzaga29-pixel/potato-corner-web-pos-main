import { Router, type NextFunction, type Request, type Response } from 'express';
import { auditLogListQuerySchema } from '@potato-corner/shared';
import { auditService } from './audit.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';

const router: Router = Router();

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

// Audit log review is a Super Admin-exclusive workflow, same as fraud
// alerts — no supervisor/staff access, so branchGuard never applies here.
router.get('/', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = auditLogListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const result = await auditService.listLogs({
      action: parsed.data.action,
      entityType: parsed.data.entity_type,
      entityId: parsed.data.entity_id,
      actorId: parsed.data.actor_id,
      branchId: parsed.data.branch_id,
      dateFrom: parsed.data.date_from,
      dateTo: parsed.data.date_to,
      page: parsed.data.page,
      limit: parsed.data.limit,
    });
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    next(error);
  }
});

export { router as auditRouter };
