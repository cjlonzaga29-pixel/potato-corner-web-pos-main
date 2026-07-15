/**
 * Cross-package re-export of the API's test-token generator, so any test
 * in the project (e2e specs, or a future app's integration tests) can sign
 * real, RS256-valid JWTs without duplicating the payload-building logic.
 * The canonical implementation lives in apps/api/src/test-utils/auth-tokens.ts
 * — it needs to stay inside apps/api's TypeScript project (rootDir: "src")
 * so apps/api's own tsc build/type-check can resolve it; this file is the
 * project-root-level entry point named in the Phase 2 spec.
 */
export * from '../../apps/api/src/test-utils/auth-tokens.js';
