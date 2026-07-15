import { ROLE_DASHBOARDS } from '@potato-corner/shared';

// Relative on purpose: browser requests go through this app's own /api/*
// rewrite (see next.config.ts) rather than straight to the API's own
// domain, so the API's Set-Cookie (refresh_token) lands on this app's
// origin — the one apps/web/middleware.ts actually checks.
export const API_URL = '';
export const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? 'http://localhost:4000';

/** Where each role lands after login. Re-exported from @potato-corner/shared, the single source of truth also used by apps/web/middleware.ts. */
export const ROLE_DASHBOARD_PATHS = ROLE_DASHBOARDS;

/** Philippine denomination values, largest to smallest — the canonical order for cash-count UI and totals. */
export const PHILIPPINE_DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01] as const;

export const DENOMINATION_LABELS: Record<number, string> = {
  1000: '₱1000',
  500: '₱500',
  200: '₱200',
  100: '₱100',
  50: '₱50',
  20: '₱20',
  10: '₱10',
  5: '₱5',
  1: '₱1',
  0.25: '25¢',
  0.1: '10¢',
  0.05: '5¢',
  0.01: '1¢',
};

export const MAX_HELD_ORDERS = 3;
export const HELD_ORDER_EXPIRY_MINUTES = 15;
export const OFFLINE_SYNC_CHECK_INTERVAL = 30000;
export const PRODUCT_CACHE_REFRESH_MINUTES = 30;
export const CASH_VARIANCE_MINIMUM_EXPLANATION = 50;
export const GPS_CLOCK_IN_RADIUS_METERS = 100;
export const TIME_DELTA_FLAG_THRESHOLD_MINUTES = 10;
export const MAX_LOGIN_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MINUTES = 30;
export const GCASH_REFERENCE_MIN_LENGTH = 10;
export const GCASH_REFERENCE_MAX_LENGTH = 20;
export const REPORT_CACHE_REFRESH_MINUTES = 15;
export const FRAUD_VOID_THRESHOLD = 3;
export const FRAUD_DISCOUNT_THRESHOLD = 5;
export const FRAUD_VARIANCE_PATTERN_THRESHOLD = 0.3;
export const FRAUD_ID_REUSE_THRESHOLD = 3;
export const FRAUD_EOD_VOID_WINDOW_MINUTES = 10;
