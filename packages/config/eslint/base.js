// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Shared base ESLint flat config used by every app in the monorepo. */
export const baseConfig = tseslint.config(
  // A config object with ONLY `ignores` (no `files`/`rules`) acts as a
  // global ignore — combining `ignores` into the rules object below would
  // only scope it to that object, not exclude the paths from linting
  // entirely.
  { ignores: ['dist/**', '.next/**', 'node_modules/**', 'coverage/**', '.turbo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);

export default baseConfig;
