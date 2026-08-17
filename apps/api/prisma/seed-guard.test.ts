import { describe, it, expect } from 'vitest';
import { assertSeedAllowed, SeedGuardError } from './seed-guard.js';

describe('assertSeedAllowed', () => {
  it('refuses when NODE_ENV is production, even with the allow flag set', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production', ALLOW_DATABASE_SEED: 'true' })).toThrow(SeedGuardError);
  });

  it('refuses when the explicit allow flag is missing', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', ALLOW_DATABASE_SEED: undefined })).toThrow(SeedGuardError);
  });

  it('refuses when the allow flag is set to something other than the literal string "true"', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', ALLOW_DATABASE_SEED: '1' })).toThrow(SeedGuardError);
  });

  it('allows a safe development environment with the allow flag explicitly set', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', ALLOW_DATABASE_SEED: 'true' })).not.toThrow();
  });

  it('allows a safe test environment with the allow flag explicitly set', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'test', ALLOW_DATABASE_SEED: 'true' })).not.toThrow();
  });

  it('refuses when NODE_ENV is unset (undefined is never treated as a safe environment)', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: undefined, ALLOW_DATABASE_SEED: undefined })).toThrow(SeedGuardError);
  });
});
