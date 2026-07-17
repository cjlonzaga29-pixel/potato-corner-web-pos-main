import { Router, type NextFunction, type Request, type Response } from 'express';
import { notificationListQuerySchema } from '@potato-corner/shared';
import { notificationsService } from './notifications.service.js';
import { NotificationError } from './notifications.types.js';
import { authenticate } from '../../middleware/authenticate.js';

const router: Router = Router();

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleNotificationError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof NotificationError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message }, meta: null });
    return;
  }
  next(error);
}

// Every route: authenticate only — every role reads/marks its own
// notifications, there is no admin-only view of another user's inbox.
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = notificationListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const result = await notificationsService.listForRecipient(req.user.user_id, {
      page: parsed.data.page,
      limit: parsed.data.limit,
    });
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleNotificationError(error, res, next);
  }
});

router.patch('/read-all', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = await notificationsService.markAllRead(req.user.user_id);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleNotificationError(error, res, next);
  }
});

router.patch('/:id/read', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    await notificationsService.markRead(req.params.id as string, req.user.user_id);
    res.status(200).json({ data: { id: req.params.id }, error: null, meta: null });
  } catch (error) {
    handleNotificationError(error, res, next);
  }
});

export { router as notificationsRouter };
