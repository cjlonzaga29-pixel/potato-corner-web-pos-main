import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

/**
 * Validates the request body against a Zod schema before the route's
 * business logic runs. Every endpoint that accepts a payload uses this.
 * Returns 422 with field-level error details on failure.
 */
export function validate(schema: ZodType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fieldErrors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR', fields: fieldErrors }, meta: null });
      return;
    }
    req.body = result.data;
    next();
  };
}
