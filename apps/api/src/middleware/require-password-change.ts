import type { NextFunction, Request, Response } from 'express';

/**
 * Blocks any authenticated request from a user flagged must_change_password
 * (Phase 5 locked rule: a brand-new or reactivated account cannot use any
 * feature until it sets its own password). Must run after `authenticate` —
 * it reads req.user.must_change_password, which authenticate populates
 * from the JWT.
 *
 * Two routes are permanently exempt so a user stuck behind this gate can
 * still clear it or leave: POST /api/auth/change-password (the only way to
 * flip the flag) and POST /api/auth/logout.
 *
 * NOT wired into every Phase 1–4 router here — this project's routers apply
 * `authenticate` per-route rather than globally (see app.ts), so enforcing
 * this app-wide would mean editing every existing module's router files,
 * which the Phase 5 brief also says not to touch. It's applied to this
 * phase's own employees router; extending it to earlier modules is a
 * follow-up decision for whoever owns that retrofit.
 */
const EXEMPT_PATHS = new Set(['/api/auth/change-password', '/api/auth/logout']);

export function requirePasswordChange(req: Request, res: Response, next: NextFunction): void {
  const path = req.originalUrl.split('?')[0];
  if (path && EXEMPT_PATHS.has(path)) {
    next();
    return;
  }

  if (req.user?.must_change_password) {
    res.status(403).json({ data: null, error: { code: 'MUST_CHANGE_PASSWORD' }, meta: null });
    return;
  }

  next();
}
