import { Prisma } from '@prisma/client';

/**
 * POS-PERF-P66 — true when a delete was refused because another row still
 * references the one being deleted. Postgres raises 23503 for NO ACTION
 * references (Prisma maps it to P2003) but 23001 (restrict_violation) for
 * ON DELETE RESTRICT, which Prisma 5 surfaces as an *unknown* request error.
 * Missing the second case is what turned "Delete" into a bare 500
 * ("Something went wrong") for an account or branch with history.
 */
export function isForeignKeyRestriction(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === 'P2003';
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /code: "23001"|code: "23503"|violates (RESTRICT setting of )?foreign key constraint/.test(error.message);
  }
  return false;
}

/**
 * POS-PERF-P67 — true when a write named a branch that has been deleted
 * (the live-branch trigger refused it). The work itself is not lost
 * silently: the caller gets 409 BRANCH_DELETED and nothing was written.
 */
export function isDeletedBranchWrite(error: unknown): boolean {
  if (error instanceof Error) return error.message.includes('POS_PERF_P67_BRANCH_DELETED');
  return false;
}

/** POS-PERF-P68 — the database refused a write because a Force Delete has fenced the branch. */
export function isFencedBranchWrite(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('POS_PERF_P68_BRANCH_DELETION_IN_PROGRESS')
  );
}

/**
 * Product permanent delete — true when a sale line, held-order line or change
 * log named a product (or size) that was permanently deleted meanwhile (the
 * live-product trigger refused it). Nothing was written.
 */
export function isDeletedProductWrite(error: unknown): boolean {
  return error instanceof Error && error.message.includes('PRODUCT_PERMANENTLY_DELETED');
}
