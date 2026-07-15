import type { Request } from 'express';

/**
 * Extracts branch_id from a request, checking params, then query, then
 * body, in that order (Architecture doc §3.4). Shared by branch-guard and
 * shift-guard so both middleware apply identical extraction semantics.
 */
export function extractBranchId(req: Request): string | undefined {
  const fromParams = req.params.branchId ?? req.params.branch_id;
  const fromQuery = req.query.branchId ?? req.query.branch_id;
  const fromBody =
    (req.body as Record<string, unknown> | undefined)?.branchId ??
    (req.body as Record<string, unknown> | undefined)?.branch_id;

  const candidate = fromParams ?? fromQuery ?? fromBody;
  return typeof candidate === 'string' ? candidate : undefined;
}
