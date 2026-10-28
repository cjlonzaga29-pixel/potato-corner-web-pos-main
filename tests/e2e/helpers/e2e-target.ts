// POS-PERF-P44 — the one place that decides which web app a Playwright config
// may target. Two modes, never mixed:
//
// - Production-safe smoke (pilot-smoke, production-smoke, p3-verify, the
//   read-only *.production.spec.ts files): PLAYWRIGHT_BASE_URL must be set
//   explicitly to an approved production origin, or to a local origin for
//   rehearsal. There is no default — an unset variable is an error, not a
//   silent run against production.
// - Isolated (the shared playwright.config.ts with its seeded accounts,
//   fixture scripts and business-data writes): defaults to localhost, refuses
//   every production host outright, and accepts a non-local host only when
//   E2E_ISOLATED_REMOTE_HOST names that exact host (a dedicated test
//   environment the operator has confirmed is not production or shared).
//
// Plain exports with no Playwright import so `node --test` can exercise it.

export const PRODUCTION_ORIGINS: readonly string[] = ['https://potatorenovare.com', 'https://www.potatorenovare.com'];

const PRODUCTION_HOST_SUFFIX = 'potatorenovare.com';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const DEFAULT_ISOLATED_BASE_URL = 'http://localhost:3000';

type Env = Record<string, string | undefined>;

function parseUrl(raw: string, name: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
}

export function isLocalUrl(raw: string): boolean {
  return LOCAL_HOSTS.has(parseUrl(raw, 'URL').hostname);
}

/**
 * The production domain or any subdomain of it. A *.vercel.app deployment URL
 * of the production project is just as much production, but it can't be told
 * apart by name — it is non-local, so resolveIsolatedBaseURL still refuses it
 * unless an operator explicitly (and wrongly) confirms it.
 */
export function isProductionUrl(raw: string): boolean {
  const host = parseUrl(raw, 'URL').hostname.toLowerCase();
  return host === PRODUCTION_HOST_SUFFIX || host.endsWith(`.${PRODUCTION_HOST_SUFFIX}`);
}

/** Base URL for configs whose specs only read (plus sign-in/sign-out). */
export function resolveProductionSmokeBaseURL(env: Env = process.env): string {
  const raw = env.PLAYWRIGHT_BASE_URL?.trim();
  if (!raw) {
    throw new Error(
      'PLAYWRIGHT_BASE_URL must be set explicitly for the production-safe smoke suites ' +
        `(${PRODUCTION_ORIGINS.join(' or ')}, or a local origin for rehearsal) — there is no default target`,
    );
  }
  const origin = parseUrl(raw, 'PLAYWRIGHT_BASE_URL').origin;
  if (PRODUCTION_ORIGINS.includes(origin) || isLocalUrl(raw)) return origin;
  throw new Error(
    `PLAYWRIGHT_BASE_URL ${origin} is neither an approved production origin nor local — refusing to run the production-safe smoke suite`,
  );
}

/** Base URL for configs that seed, write, or reset business data. */
export function resolveIsolatedBaseURL(env: Env = process.env): string {
  const raw = env.PLAYWRIGHT_BASE_URL?.trim() || DEFAULT_ISOLATED_BASE_URL;
  const url = parseUrl(raw, 'PLAYWRIGHT_BASE_URL');
  if (isProductionUrl(raw)) {
    throw new Error(`PLAYWRIGHT_BASE_URL ${url.origin} is production — mutating E2E suites never run against production`);
  }
  if (isLocalUrl(raw)) return url.origin;
  const confirmedHost = env.E2E_ISOLATED_REMOTE_HOST?.trim().toLowerCase();
  if (confirmedHost && confirmedHost === url.hostname.toLowerCase()) return url.origin;
  throw new Error(
    `PLAYWRIGHT_BASE_URL ${url.origin} is not local. Mutating E2E suites run against a remote host only when ` +
      'E2E_ISOLATED_REMOTE_HOST names that exact host (a dedicated, isolated test environment — never production or a shared database)',
  );
}
