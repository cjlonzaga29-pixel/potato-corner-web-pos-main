// @ts-check
import { FlatCompat } from '@eslint/eslintrc';
import { baseConfig } from './base.js';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

/** Shared Next.js ESLint flat config, layered on top of the base config. */
export const nextConfig = [...baseConfig, ...compat.extends('next/core-web-vitals', 'next/typescript')];

export default nextConfig;
