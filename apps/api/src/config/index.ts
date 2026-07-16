import { z } from 'zod';

/**
 * PEM keys are stored in .env with literal `\n` sequences (real newlines
 * aren't valid inside a single .env line) — convert them back before use.
 */
function normalizePem(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
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
  REDIS_URL: z.string().min(1),
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
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
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
  redis: { url: env.REDIS_URL },
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
} as const;
