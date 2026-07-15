import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // bcrypt at cost factor 12 (the locked rule — never lowered for tests)
    // takes 250ms-1.5s per hash depending on machine load, and several
    // tests hash multiple times; the default 5s timeout is too tight when
    // running alongside other CPU-bound tasks (build/lint in parallel).
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules', 'prisma', 'dist', '**/*.d.ts'],
    },
  },
});
