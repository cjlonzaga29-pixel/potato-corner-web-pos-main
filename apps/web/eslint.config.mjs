import { nextConfig } from '@potato-corner/config/eslint/next';

const eslintConfig = [
  ...nextConfig,
  {
    ignores: ['node_modules/**', '.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'public/**'],
  },
];

export default eslintConfig;
