import type { NextFunction, Request, Response } from 'express';
import { ROLES, type Role } from '@potato-corner/shared';
import { config } from '../config/index.js';

/** Restricts a route to one or more roles. Must run after `authenticate`. */
export function authorize(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        data: null,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          // Non-production only — never leak role/route details to a
          // production client, but a dev/staging 403 body is otherwise
          // opaque about which of {no req.user, wrong role} actually fired
          // and what the route required.
          ...(!config.isProduction && {
            details: {
              authenticated: Boolean(req.user),
              userId: req.user?.user_id ?? null,
              role: req.user?.role ?? null,
              allowedRoles,
              route: req.baseUrl + req.path,
              method: req.method,
            },
          }),
        },
        meta: null,
      });
      return;
    }
    next();
  };
}

/** Convenience exports for the common role combinations used across route definitions. */
export const adminOnly = authorize(ROLES.SUPER_ADMIN);
export const adminOrSupervisor = authorize(ROLES.SUPER_ADMIN, ROLES.SUPERVISOR);
export const supervisorOnly = authorize(ROLES.SUPERVISOR);
export const allRoles = authorize(ROLES.SUPER_ADMIN, ROLES.SUPERVISOR, ROLES.STAFF);
