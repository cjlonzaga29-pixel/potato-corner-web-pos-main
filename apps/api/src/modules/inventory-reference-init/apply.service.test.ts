import { describe, it, expect } from 'vitest';
import { applyManifest, ApplyRefusedError } from './apply.service.js';
import { PHASE_C0_MANIFEST } from './manifest.js';

/**
 * These guard checks are asserted BEFORE any database access in
 * `applyManifest` (see apply.service.ts) -- they run safely without
 * TEST_DATABASE_URL, unlike the DB-backed apply path itself, which this
 * task explicitly does not execute (see NON-NEGOTIABLES: "Do not execute
 * apply during this task").
 */
describe('applyManifest — pre-database guards (no DB required)', () => {
  it('refuses when confirm is not literal true', async () => {
    await expect(
      applyManifest({
        manifest: PHASE_C0_MANIFEST,
        migrationBatch: 'test-batch',
        targetEnvironment: 'local',
        confirm: false as unknown as true,
        acknowledgeRollbackReviewed: true,
      }),
    ).rejects.toThrow(ApplyRefusedError);
  });

  it('refuses when acknowledgeRollbackReviewed is not literal true', async () => {
    await expect(
      applyManifest({
        manifest: PHASE_C0_MANIFEST,
        migrationBatch: 'test-batch',
        targetEnvironment: 'local',
        confirm: true,
        acknowledgeRollbackReviewed: false as unknown as true,
      }),
    ).rejects.toThrow(ApplyRefusedError);
  });
});
