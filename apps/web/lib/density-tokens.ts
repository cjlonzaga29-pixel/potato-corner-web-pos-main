import type { DensityMode } from '@/hooks/use-density-mode';

/**
 * Task 200 (adaptive density engine) — JS-side values that mirror the CSS
 * custom-property tiers in app/globals.css (`:root[data-density="..."]`
 * blocks). CSS can express nearly everything density-related (spacing,
 * sizing, KPI grid column counts via `.app-kpi-grid-*`); these maps exist
 * only for the handful of things JS genuinely needs a number/class string
 * for — Recharts pixel heights and the POS product grid's column count
 * (which depends on pointer/touch capability, not just width, so a plain
 * Tailwind breakpoint can't express it). Keep these numbers consistent with
 * globals.css by hand — there is no single source both sides can read from,
 * since one is CSS and the other is a compile-time TS map.
 */

/** Recharts `ResponsiveContainer` height in px — callers that pass an explicit `height` prop always override this. */
export const DENSITY_CHART_HEIGHT: Record<DensityMode, number> = {
  comfortable: 280,
  standard: 240,
  compact: 190,
  'compact-touch': 220,
  mobile: 200,
};

/**
 * Reference values only (not read by any render path) — documents the
 * touch-safety floor enforced by globals.css's `compact-touch`/`mobile`
 * data-density blocks (`--app-control-height` / `--app-table-row-height`),
 * and gives the "table stays touch-safe" test something concrete to assert
 * against without measuring rendered pixels in jsdom.
 */
export const DENSITY_CONTROL_HEIGHT_PX: Record<DensityMode, number> = {
  comfortable: 44,
  standard: 40,
  compact: 36,
  'compact-touch': 44,
  mobile: 44,
};

export const DENSITY_TABLE_ROW_HEIGHT_PX: Record<DensityMode, number> = {
  comfortable: 46,
  standard: 42,
  compact: 38,
  'compact-touch': 46,
  mobile: 46,
};

/** Minimum touch target per Task 196/200 — never go below this for coarse-pointer modes. */
export const TOUCH_SAFE_MIN_PX = 44;

/**
 * POS terminal product grid column count — the one piece of the grid that's
 * genuinely structural (React-branched), not CSS-only, because it depends on
 * pointer/touch capability which a width-only Tailwind breakpoint can't
 * express. The loading skeleton grid reuses this exact map so the two can
 * never drift out of sync (Task 200 requirement: "one shared
 * responsive/density definition").
 *
 * Task 209.8 (compact POS redesign) — `standard` and `compact` raised from 4
 * to 5 columns: at the priority 1366x768 laptop viewport (which classifies as
 * `compact` — see classifyDensity's height-aware branch) a 30% cart leaves
 * ~890px of product width after grid padding/gaps, which comfortably fits 5
 * cards >=170px wide while still keeping >=3 full rows visible before
 * scrolling. `compact-touch` stays at 3 (not raised to 4): it's the one
 * bucket that has to serve both a touch laptop/2-in-1 (room for 4) and a
 * narrower portrait tablet (room for only 2-3) since density classification
 * doesn't split touch by orientation — 3 is the safe overlap of both ranges.
 */
export const DENSITY_POS_GRID_COLUMNS: Record<DensityMode, string> = {
  comfortable: 'grid-cols-5',
  standard: 'grid-cols-5',
  compact: 'grid-cols-5',
  'compact-touch': 'grid-cols-3',
  mobile: 'grid-cols-2',
};
