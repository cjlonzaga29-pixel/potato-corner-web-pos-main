import { ROLES, type JwtPayload } from '@potato-corner/shared';

type BranchErrorCtor = new (code: string, message: string, statusCode?: number, details?: unknown) => Error;

/** super_admin sees everything; supervisor/staff are scoped to their JWT branch_ids — never trust a client-supplied branch list. */
export function getAccessibleBranchIds(actor: JwtPayload): string[] | 'all' {
  if (actor.role === ROLES.SUPER_ADMIN) return 'all';
  return actor.branch_ids;
}

export function assertBranchAccess(actor: JwtPayload, branchId: string, ErrorClass: BranchErrorCtor): void {
  const accessible = getAccessibleBranchIds(actor);
  if (accessible === 'all') return;
  if (!accessible.includes(branchId)) {
    throw new ErrorClass('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
  }
}
