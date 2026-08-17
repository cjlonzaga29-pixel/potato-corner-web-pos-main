import { z } from 'zod';

/**
 * PEM keys are stored in .env with literal `\n` sequences (real newlines
 * aren't valid inside a single .env line) — convert them back before use.
 */
function normalizePem(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

/**
 * CR-012.1A -- pure parser for SHADOW_BOM_DEDUCTION_BRANCH_IDS, exported
 * standalone so its whitespace/dedupe/validation behavior can be unit tested
 * without reloading the whole env-dependent config module. Trims whitespace,
 * drops empty entries, and rejects (via the caller's zod .refine) anything
 * that isn't a valid UUID -- never queries the database.
 */
export function parseShadowBomDeductionBranchIds(raw: string): string[] {
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return Array.from(new Set(ids));
}

/**
 * CR-012.1A -- pure decision function backing isShadowBomDeductionEnabledForBranch,
 * exported standalone so rollout behavior (disabled / all-branches / included /
 * excluded) can be unit tested without depending on the process-wide env singleton.
 */
export function computeShadowBomDeductionEnabledForBranch(
  globalEnabled: boolean,
  branchIds: readonly string[],
  branchId: string,
): boolean {
  if (!globalEnabled) return false;
  if (branchIds.length === 0) return true;
  return branchIds.includes(branchId);
}

/**
 * CR-012.1A -- standalone zod schema for SHADOW_BOM_DEDUCTION_BRANCH_IDS,
 * exported so its whitespace/dedupe/malformed-UUID-rejection behavior can be
 * unit tested directly via .safeParse() without loading the full env schema.
 */
export const shadowBomDeductionBranchIdsSchema = z
  .string()
  .default('')
  .transform((value) => parseShadowBomDeductionBranchIds(value))
  .refine((ids) => ids.every((id) => z.uuid().safeParse(id).success), {
    message: 'SHADOW_BOM_DEDUCTION_BRANCH_IDS must be a comma-separated list of valid UUIDs',
  });

/**
 * POS checkout — createTransaction's interactive $transaction (see
 * transactions.service.ts) does a bounded but multi-round-trip write: the
 * transaction/items insert plus a lock/read/update/movement-insert cycle per
 * BOM component. Prisma's un-configured defaults (2s maxWait, 5s timeout)
 * are sized for single-statement transactions and reliably trip P2028
 * ("Transaction already closed") for a several-component BOM under
 * realistic remote-DB latency or transient connection-pool contention.
 * Scoped to this one call site (not a global Prisma default) rather than
 * raising it everywhere -- most other $transaction calls in this codebase
 * are single- or few-statement and shouldn't be allowed to hold a
 * connection open for 30s if something hangs.
 */
export const posTransactionMaxWaitMsSchema = z.coerce
  .number()
  .int('PRISMA_TRANSACTION_MAX_WAIT_MS must be an integer')
  .positive('PRISMA_TRANSACTION_MAX_WAIT_MS must be greater than 0')
  .max(60_000, 'PRISMA_TRANSACTION_MAX_WAIT_MS must be 60000 or less')
  .default(10_000);

export const posTransactionTimeoutMsSchema = z.coerce
  .number()
  .int('PRISMA_TRANSACTION_TIMEOUT_MS must be an integer')
  .positive('PRISMA_TRANSACTION_TIMEOUT_MS must be greater than 0')
  .max(120_000, 'PRISMA_TRANSACTION_TIMEOUT_MS must be 120000 or less')
  .default(30_000);

/**
 * maxWait only bounds how long checkout waits to acquire a transaction slot;
 * timeout bounds the entire checkout write once it starts. A maxWait longer
 * than the timeout is never sane (the wait alone could exhaust the whole
 * budget), so this is rejected at boot rather than left to surface as a
 * confusing runtime failure.
 */
export function assertPosTransactionTimingSane(maxWaitMs: number, timeoutMs: number): void {
  if (maxWaitMs > timeoutMs) {
    throw new Error(
      `PRISMA_TRANSACTION_MAX_WAIT_MS (${maxWaitMs}) must not exceed PRISMA_TRANSACTION_TIMEOUT_MS (${timeoutMs}) -- ` +
        'maxWait only bounds the wait for a transaction slot; timeout bounds the whole checkout write.',
    );
  }
}

/**
 * Validates process.env at boot. Fails fast with a clear, field-level error
 * if a required variable is missing, instead of surfacing a confusing
 * failure deep inside a request handler later.
 *
 * Env var naming note: this project's Phase 0 scaffold established
 * API_PORT (not PORT), NEXT_PUBLIC_APP_URL (not FRONTEND_URL), and
 * SUPABASE_SERVICE_ROLE_KEY (not SUPABASE_SERVICE_KEY). Those names are
 * kept as the canonical ones — they already serve the same purpose
 * (listen port / CORS origin / Supabase admin key) and are referenced
 * across multiple existing files (app.ts, socket.server.ts, supabase.ts).
 */
const envSchema = z.object({
  // 'test' is included because Vitest sets NODE_ENV=test automatically.
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_PRIVATE_KEY: z.string().min(1).transform(normalizePem),
  JWT_PUBLIC_KEY: z.string().min(1).transform(normalizePem),
  JWT_ACCESS_TOKEN_TTL: z.string().default('15m'),
  JWT_REFRESH_TOKEN_TTL: z.string().default('7d'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z.string().min(1),
  HASH_KEY: z.string().min(1),
  SUPABASE_URL: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().min(1).default('http://localhost:3000'),
  SENTRY_DSN: z.string().optional(),
  // Not required — email.ts already fails loudly per-request outside
  // development when these are absent (see sendPasswordResetEmail). Typed
  // here instead of read via raw process.env so config validation and the
  // production-readiness warning below have one source of truth.
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
  /**
   * CR-010A.1 — off by default; existing movement-write behavior is
   * unchanged until explicitly enabled. "true"/"false" only — z.coerce.boolean()
   * would treat the literal string "false" as truthy.
   */
  INVENTORY_PROJECTION_OUTBOX_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * CR-012.1 -- off by default. When true, a completed sale fires a
   * best-effort, non-blocking shadow BOM comparison after the legacy
   * deduction/transaction already committed; when false, zero extra
   * calculation and zero ShadowBomComparison rows are produced. Never
   * affects the legacy deduction path or POS response either way.
   */
  SHADOW_BOM_DEDUCTION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * CR-012.1A -- optional branch allowlist for the shadow comparison, parsed
   * from a comma-separated string purely by string/regex validation (no DB
   * lookup at config-load time: a typo'd or since-deleted branch id must
   * fail fast here rather than surface as a silent no-op at request time).
   * Empty/unset means "all branches" when SHADOW_BOM_DEDUCTION_ENABLED is
   * true -- see shadowBomDeductionBranchIds below for the parsed set.
   */
  SHADOW_BOM_DEDUCTION_BRANCH_IDS: shadowBomDeductionBranchIdsSchema,
  PRISMA_TRANSACTION_MAX_WAIT_MS: posTransactionMaxWaitMsSchema,
  PRISMA_TRANSACTION_TIMEOUT_MS: posTransactionTimeoutMsSchema,
});

/**
 * Supabase's transaction-mode pooler (port 6543) multiplexes connections
 * across clients, so it can't hold server-side prepared statements — Prisma
 * must be told to fall back to unnamed statements via `pgbouncer=true` in
 * the connection string's query params. A missing or malformed flag here
 * (e.g. a bad `?`/`&` separator swallowing the param) doesn't fail until
 * requests start throwing "prepared statement already exists" under load,
 * well after boot. Catch it at startup instead.
 */
function assertPgBouncerCompatible(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const isTransactionPooler = url.port === '6543';
  if (isTransactionPooler && url.searchParams.get('pgbouncer') !== 'true') {
    throw new Error(
      'DATABASE_URL targets the Supabase transaction pooler (port 6543) but is missing ' +
        '"pgbouncer=true" in its query string. Without it, Prisma will attempt server-side ' +
        'prepared statements against a connection-multiplexing pooler that cannot support them, ' +
        'causing intermittent "prepared statement already exists" errors under load. ' +
        'Add ?pgbouncer=true (or &pgbouncer=true if other params are already present).',
    );
  }
}

/**
 * Password reset / welcome / fraud-alert emails already fail loudly per
 * request outside development when RESEND_API_KEY is unset (see
 * sendPasswordResetEmail in lib/email.ts) — that's what actually stops a
 * silent "success" response from a nonexistent provider. This is a
 * boot-time warning on top of that, so a misconfigured production
 * deployment is visible in the logs immediately instead of only surfacing
 * the first time someone requests a password reset. Deliberately a
 * warning, not a thrown error — email delivery being unavailable must not
 * take down the rest of the POS.
 */
export function warnIfEmailDeliveryMisconfigured(data: {
  NODE_ENV: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  NEXT_PUBLIC_APP_URL: string;
}): void {
  if (data.NODE_ENV === 'development' || data.NODE_ENV === 'test') return;

  if (!data.RESEND_API_KEY) {
    console.warn('[config] RESEND_API_KEY is not set — password reset, welcome, and fraud alert emails will fail to send.');
  }
  if (!data.EMAIL_FROM) {
    console.warn('[config] EMAIL_FROM is not set — outgoing emails will fall back to a placeholder sender address.');
  }
  if (/^https?:\/\/localhost(:\d+)?/i.test(data.NEXT_PUBLIC_APP_URL)) {
    console.warn(`[config] NEXT_PUBLIC_APP_URL is "${data.NEXT_PUBLIC_APP_URL}" outside development — generated links (e.g. password reset) will point at localhost.`);
  }
}

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  assertPgBouncerCompatible(result.data.DATABASE_URL);
  assertPosTransactionTimingSane(result.data.PRISMA_TRANSACTION_MAX_WAIT_MS, result.data.PRISMA_TRANSACTION_TIMEOUT_MS);
  warnIfEmailDeliveryMisconfigured(result.data);
  return result.data;
}

export const env = loadConfig();

/** Typed config object, grouped by concern, for use throughout the application. */
export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.API_PORT,
  frontendUrl: env.NEXT_PUBLIC_APP_URL,
  database: { url: env.DATABASE_URL },
  jwt: {
    privateKey: env.JWT_PRIVATE_KEY,
    publicKey: env.JWT_PUBLIC_KEY,
    accessTokenTtl: env.JWT_ACCESS_TOKEN_TTL,
    refreshTokenTtl: env.JWT_REFRESH_TOKEN_TTL,
    refreshSecret: env.JWT_REFRESH_SECRET,
  },
  encryptionKey: env.ENCRYPTION_KEY,
  hashKey: env.HASH_KEY,
  supabase: { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY },
  sentryDsn: env.SENTRY_DSN,
  email: { resendApiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM },
  inventoryProjectionOutboxEnabled: env.INVENTORY_PROJECTION_OUTBOX_ENABLED,
  shadowBomDeductionEnabled: env.SHADOW_BOM_DEDUCTION_ENABLED,
  shadowBomDeductionBranchIds: env.SHADOW_BOM_DEDUCTION_BRANCH_IDS,
  /** POS checkout's createTransaction $transaction options — see posTransactionMaxWaitMsSchema above. */
  posTransaction: {
    maxWaitMs: env.PRISMA_TRANSACTION_MAX_WAIT_MS,
    timeoutMs: env.PRISMA_TRANSACTION_TIMEOUT_MS,
  },
} as const;

/**
 * CR-012.1A -- true when the shadow comparison should run for this branch.
 * Global-disabled always short-circuits to false regardless of the branch
 * list. An empty branch list with the global flag on means "all branches".
 * Pure/synchronous (no DB access) so callers can gate *before* doing any
 * shadow work -- an excluded branch must incur zero shadow queries.
 */
export function isShadowBomDeductionEnabledForBranch(branchId: string): boolean {
  return computeShadowBomDeductionEnabledForBranch(config.shadowBomDeductionEnabled, config.shadowBomDeductionBranchIds, branchId);
}
