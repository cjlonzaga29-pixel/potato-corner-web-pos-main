'use client';

import { useEffect } from 'react';
import { useDensityMode } from '@/hooks/use-density-mode';

/**
 * Task 200 (adaptive density engine) — mounted once near the root
 * (app/layout.tsx) so `data-density` is available on `<html>` for every
 * authenticated route, including the standalone `/notifications` page which
 * isn't nested inside any of the three role shells. Writes the attribute
 * imperatively post-hydration (same pattern next-themes uses for
 * `data-theme`) instead of during SSR — this component renders nothing, so
 * there is no hydration mismatch. The one-frame flash before the effect
 * runs is acceptable: `data-density` only ever gates spacing/sizing tokens,
 * never colors, so there's nothing visually jarring to flash.
 */
export function DensityAttribute() {
  const mode = useDensityMode();

  useEffect(() => {
    document.documentElement.setAttribute('data-density', mode);
  }, [mode]);

  return null;
}
