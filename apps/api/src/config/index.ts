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

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  assertPgBouncerCompatible(result.data.DATABASE_URL);
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
  inventoryProjectionOutboxEnabled: env.INVENTORY_PROJECTION_OUTBOX_ENABLED,
  shadowBomDeductionEnabled: env.SHADOW_BOM_DEDUCTION_ENABLED,
  shadowBomDeductionBranchIds: env.SHADOW_BOM_DEDUCTION_BRANCH_IDS,
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
