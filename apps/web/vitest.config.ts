import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';

// POS-PERF-P62 — on Windows a shell can report the drive letter in lower case
// (VS Code's terminal does: c:\...). Vite then resolved `react` under c:\ while
// Node's own require from react-dom used the real C:\ path, so two copies of
// React loaded and every hook test failed with "Cannot read properties of null
// (reading 'useEffect')": 15/15 in use-auth from c:\, 15/15 passing from C:\.
// Setting `root` alone did not help (still 19/19 failing): the test workers
// inherit this process's cwd, so the cwd itself is moved to the real on-disk
// path before they start. No effect on Linux CI, where the path is unchanged.
const root = realpathSync.native(__dirname);
if (process.cwd() !== root && process.cwd().toLowerCase() === root.toLowerCase()) process.chdir(root);

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@': root,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules', '.next', 'dist', '**/*.d.ts'],
    },
  },
});
