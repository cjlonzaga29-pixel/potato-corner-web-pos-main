import type { FullConfig } from '@playwright/test';
import { bootstrapProdSession } from './helpers/prod-login';

/**
 * Distinct from global-setup.ts (which logs in seeded LOCAL test accounts
 * that don't exist on production). This performs the single real production
 * login the whole suite shares — see helpers/prod-login.ts for why: loginLimiter
 * caps POST /api/auth/login at 10/15min per IP.
 */
export default async function globalSetupProduction(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'https://www.potatorenovare.com';
  await bootstrapProdSession(baseURL);
}
