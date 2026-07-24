import { Router, type NextFunction, type Request, type Response } from 'express';
import { auditLogListQuerySchema } from '@potato-corner/shared';
import { auditService } from './audit.service.js';
import { AuditError } from './audit.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminSupervisorOrBranch } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';

const router: Router = Router();

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleAuditError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof AuditError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

// CR-003: audit log review was a Super Admin-exclusive workflow; it now also
// admits supervisor (regional oversight) and branch (their own branch's
// activity). auditService.listLogs enforces the branch scoping for
// non-admin callers — a branch account can never see another branch's log
// rows — so this is not just a middleware label change, see that function's
// doc comment.
router.get('/', authenticate, adminSupervisorOrBranch, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
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
    const result = await auditService.listLogs(
      {
        action: parsed.data.action,
        entityType: parsed.data.entity_type,
        entityId: parsed.data.entity_id,
        actorId: parsed.data.actor_id,
        branchId: parsed.data.branch_id,
        dateFrom: parsed.data.date_from,
        dateTo: parsed.data.date_to,
        page: parsed.data.page,
        limit: parsed.data.limit,
      },
      req.user,
    );
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleAuditError(error, res, next);
  }
});

export { router as auditRouter };
