'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Task 200 (adaptive density engine) — the single classification every
 * authenticated surface (Admin/Supervisor/Branch/POS) reads to decide
 * spacing, sizing, and structural column counts. Supersedes the old
 * width-only Tailwind breakpoints and the height-only useCompactHeightMode
 * hook, which together never accounted for pointer precision, touch
 * capability, or orientation.
 *
 * Priority order (first match wins — mirrored exactly by both
 * `classifyDensity` below and the matchMedia-driven resolution in
 * `useDensityMode`):
 *   1. width <= 767px                                    -> mobile
 *   2. coarse pointer OR no hover capability              -> compact-touch
 *   3. width >= 1800px AND height >= 900px                -> comfortable
 *   4. width >= 1024px AND height <= 820px                -> compact
 *   5. else                                               -> standard
 */
export type DensityMode = 'comfortable' | 'standard' | 'compact' | 'compact-touch' | 'mobile';

export interface DensityClassificationInput {
  width: number;
  height: number;
  /** True when `(pointer: coarse)` or `(hover: none)` matches — a touchscreen or a device with no hover capability. */
  coarsePointer: boolean;
}

/**
 * Pure, unit-testable classification — no `window`/`matchMedia` access, so it
 * can be exercised with plain numbers for every required test case (see
 * use-density-mode.test.ts) without mocking a browser API. This is the
 * source of truth for the priority order; `useDensityMode` below evaluates
 * the equivalent real media queries and must stay logically identical to it.
 */
export function classifyDensity({ width, height, coarsePointer }: DensityClassificationInput): DensityMode {
  if (width <= 767) return 'mobile';
  if (coarsePointer) return 'compact-touch';
  if (width >= 1800 && height >= 900) return 'comfortable';
  if (width >= 1024 && height <= 820) return 'compact';
  return 'standard';
}

/**
 * The exact 4 media queries the hook listens to — named to match the mode
 * each one identifies. Kept as literal strings (not derived from
 * classifyDensity) because MediaQueryList only ever exposes "does this query
 * match right now", not the raw width/height/pointer values classifyDensity
 * takes — the two are independent expressions of the same priority table
 * above and must be kept in sync by hand.
 */
const DENSITY_QUERIES = {
  mobile: '(max-width: 767px)',
  'compact-touch': '(pointer: coarse), (hover: none)',
  comfortable: '(min-width: 1800px) and (min-height: 900px)',
  compact: '(min-width: 1024px) and (max-height: 820px)',
} as const satisfies Record<Exclude<DensityMode, 'standard'>, string>;

/** First match wins — identical priority order to classifyDensity. */
const PRIORITY_ORDER: Exclude<DensityMode, 'standard'>[] = ['mobile', 'compact-touch', 'comfortable', 'compact'];

function resolveDensityMode(matchStates: Record<Exclude<DensityMode, 'standard'>, boolean>): DensityMode {
  for (const mode of PRIORITY_ORDER) {
    if (matchStates[mode]) return mode;
  }
  return 'standard';
}

/**
 * Sets up exactly one set of matchMedia listeners (the 4 queries above) on
 * mount and tears them all down on unmount — this is the single shared
 * listener path every consumer (sidebar, header, KPI grid, tables, dialogs,
 * charts, POS terminal) relies on instead of each mounting its own.
 *
 * Starts `'standard'` — matches server render and jsdom (which has no
 * matchMedia), same defaulting pattern as the hook this replaces
 * (useCompactHeightMode) and the terminal page's old inline useIsDesktop.
 *
 * Only calls setState when the resolved mode actually differs from the
 * current one, so a resize that doesn't cross a mode boundary never
 * triggers a re-render (see the "boundary crossing" test).
 */
export function useDensityMode(): DensityMode {
  const [mode, setMode] = useState<DensityMode>('standard');
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;

    const entries = PRIORITY_ORDER.map((key) => ({ key, mql: window.matchMedia(DENSITY_QUERIES[key]) }));

    const recompute = () => {
      const matchStates = {} as Record<Exclude<DensityMode, 'standard'>, boolean>;
      for (const { key, mql } of entries) matchStates[key] = mql.matches;
      const next = resolveDensityMode(matchStates);
      if (next !== modeRef.current) setMode(next);
    };

    recompute();

    const listeners = entries.map(({ mql }) => {
      const listener = () => recompute();
      mql.addEventListener('change', listener);
      return { mql, listener };
    });

    return () => {
      for (const { mql, listener } of listeners) mql.removeEventListener('change', listener);
    };
  }, []);

  return mode;
}
