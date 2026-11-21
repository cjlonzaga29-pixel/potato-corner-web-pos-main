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
