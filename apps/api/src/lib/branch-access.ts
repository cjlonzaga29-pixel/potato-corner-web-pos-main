import { ROLES, type JwtPayload } from '@potato-corner/shared';
import { branchesRepository } from '../modules/branches/branches.repository.js';

type BranchErrorCtor = new (code: string, message: string, statusCode?: number, details?: unknown) => Error;

/**
 * super_admin sees every branch regardless of status.
 *
 * supervisor is assignment-scoped: their active UserBranchAssignment rows
 * (branch must also currently be active), resolved fresh from the database
 * on every call — never the JWT's `branch_ids` claim, which is only ever a
 * snapshot from login/refresh time and would otherwise miss an assignment
 * added after the token was minted, keep exposing one an Admin just
 * removed, or keep exposing a branch that's since gone inactive. A
 * supervisor with zero active assignments gets back an empty array — fail
 * closed, never every branch (Supervisor Branch Assignment, Phase 8).
 *
 * branch/staff remain scoped to their JWT branch_ids (always exactly one) —
 * unchanged by this rule, since those roles are still assignment-scoped.
 */
export async function getAccessibleBranchIds(actor: JwtPayload): Promise<string[] | 'all'> {
  if (actor.role === ROLES.SUPER_ADMIN) return 'all';
  if (actor.role === ROLES.SUPERVISOR) return branchesRepository.findAllActiveBranchIds(actor.user_id);
  return actor.branch_ids;
}

export async function hasBranchAccess(actor: JwtPayload, branchId: string): Promise<boolean> {
  const accessible = await getAccessibleBranchIds(actor);
  return accessible === 'all' || accessible.includes(branchId);
}

export async function assertBranchAccess(actor: JwtPayload, branchId: string, ErrorClass: BranchErrorCtor): Promise<void> {
  if (!(await hasBranchAccess(actor, branchId))) {
    throw new ErrorClass('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
  }
}
