// @ts-check
import { baseConfig } from './base.js';

/** Shared Node.js (Express backend) ESLint flat config. */
export const nodeConfig = [
  ...baseConfig,
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];

export default nodeConfig;
