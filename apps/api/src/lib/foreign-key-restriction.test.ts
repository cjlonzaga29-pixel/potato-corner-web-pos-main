import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { isForeignKeyRestriction } from './foreign-key-restriction.js';

describe('isForeignKeyRestriction (POS-PERF-P66)', () => {
  it('recognises the ON DELETE RESTRICT error Prisma reports as unknown (the reproduced "Something went wrong")', () => {
    const error = new Prisma.PrismaClientUnknownRequestError(
      'Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23001", message: "update or delete on table \\"users\\" violates RESTRICT setting of foreign key constraint \\"expense_types_created_by_id_fkey\\" on table \\"expense_types\\"" }) })',
      { clientVersion: '5.22.0' },
    );
    expect(isForeignKeyRestriction(error)).toBe(true);
  });

  it('recognises P2003 and ignores unrelated errors', () => {
    expect(isForeignKeyRestriction(new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: '5.22.0' }))).toBe(true);
    expect(isForeignKeyRestriction(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5.22.0' }))).toBe(false);
    expect(isForeignKeyRestriction(new Prisma.PrismaClientUnknownRequestError('timeout', { clientVersion: '5.22.0' }))).toBe(false);
    expect(isForeignKeyRestriction(new Error('x'))).toBe(false);
  });
});
