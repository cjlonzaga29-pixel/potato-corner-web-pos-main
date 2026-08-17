export class SeedGuardError extends Error {}

const REFUSAL_MESSAGE = 'Database seeding is disabled unless explicitly enabled for a non-production environment.';

/**
 * Refuses to run prisma/seed.ts unless both conditions hold: NODE_ENV is not
 * 'production', and ALLOW_DATABASE_SEED is explicitly 'true'. A mistaken
 * invocation against production (wrong .env loaded, wrong terminal) must
 * fail closed rather than upsert predictable credentials over live data —
 * missing/ambiguous env state refuses, it never falls through to seeding.
 */
export function assertSeedAllowed(env: Pick<NodeJS.ProcessEnv, 'NODE_ENV' | 'ALLOW_DATABASE_SEED'>): void {
  if (env.NODE_ENV === 'production') {
    throw new SeedGuardError(REFUSAL_MESSAGE);
  }
  if (env.ALLOW_DATABASE_SEED !== 'true') {
    throw new SeedGuardError(`${REFUSAL_MESSAGE} Set ALLOW_DATABASE_SEED=true to proceed.`);
  }
}
