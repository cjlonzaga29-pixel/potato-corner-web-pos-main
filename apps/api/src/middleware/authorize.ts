import type { NextFunction, Request, Response } from 'express';
import { ROLES, type Role } from '@potato-corner/shared';

/** Restricts a route to one or more roles. Must run after `authenticate`. */
export function authorize(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      res.status(403).json({ data: null, error: { code: 'INSUFFICIENT_PERMISSIONS' }, meta: null });
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
