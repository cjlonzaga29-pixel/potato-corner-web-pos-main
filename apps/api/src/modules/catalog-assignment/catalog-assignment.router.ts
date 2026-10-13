import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { createCatalogAssignmentSchema, CATALOG_RESOURCE_TYPES } from '@potato-corner/shared';
import { catalogAssignmentService } from './catalog-assignment.service.js';
import { CatalogAssignmentError } from './catalog-assignment.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

const previewQuerySchema = z.object({
  resource_type: z.enum(CATALOG_RESOURCE_TYPES),
  resource_id: z.uuid(),
});

const unmanagedQuerySchema = z.object({
  resource_type: z.enum(CATALOG_RESOURCE_TYPES),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof CatalogAssignmentError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

// POS-PERF-P35R — explicit catalog-management assignment is a Super Admin
// administrative transition action, never a restoration of Admin's catalog
// CRUD (that stays revoked, see products.router.ts et al). Supervisor has
// no access to this router at all — they cannot self-claim a shared record.

router.get('/unmanaged', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = unmanagedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const result = await catalogAssignmentService.listUnmanaged(parsed.data.resource_type, parsed.data.page, parsed.data.limit);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/preview', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = previewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const preview = await catalogAssignmentService.previewAssignment(parsed.data.resource_type, parsed.data.resource_id);
    res.status(200).json({ data: preview, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = previewQuerySchema.safeParse(req.query);
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
    handleModuleError(error, res, next);
  }
});

router.post('/', authenticate, adminOnly, requirePasswordChange, validate(createCatalogAssignmentSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const assignment = await catalogAssignmentService.createAssignment(req.body, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
    res.status(201).json({ data: assignment, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

export { router as catalogAssignmentRouter };
