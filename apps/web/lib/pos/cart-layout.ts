import type { DensityMode } from '@/hooks/use-density-mode';

/**
 * Task 200 (adaptive density engine) — replaces the terminal page's old
 * width-only `useIsDesktop()` split between the inline cart/checkout panel
 * and the mobile "View Cart" Sheet. Pure and unit-testable in isolation
 * (see cart-layout.test.ts) so this decision doesn't require a full page
 * render to verify.
 *
 * - mobile: always the Sheet — no viewport room for a persistent side panel.
 * - compact-touch / comfortable / standard / compact: all defer to
 *   `hasRoomForInlinePanel` (the terminal page's own >=1024px-width-and-
 *   >=640px-height check — the same threshold the inline cart panel's own
 *   `hidden lg:flex` Tailwind classes enforce).
 *
 * Task 209.54 — this used to hard-code "comfortable/standard/compact always
 * inline" on the assumption that a fine (non-touch) pointer implied a wide
 * viewport. classifyDensity's 'standard' tier is reachable from 768px width
 * up (anything not mobile/compact-touch/comfortable/compact falls through
 * to it) — so a fine-pointer window narrower than the 1024px `lg` breakpoint
 * (a resized desktop browser, a non-touch 2-in-1, or simply a DevTools width
 * resize without the touch-emulation checkbox ticked) got `isDesktop: true`
 * from this function while the inline panel's own `hidden lg:flex` classes
 * kept it hidden below 1024px — and the `{!isDesktop && ...}` mobile Sheet
 * branch never rendered either, since JS believed desktop was in play.
 * Result: neither cart UI existed in the DOM at all — Checkout was
 * completely unreachable. Deferring to `hasRoomForInlinePanel` uniformly
 * closes that gap; comfortable (>=1800x900) and compact (>=1024px width by
 * its own classifyDensity definition) already satisfy it in every real case,
 * so this only changes behavior for the previously-broken dead zone.
 */
export function shouldShowInlineCart(mode: DensityMode, hasRoomForInlinePanel: boolean): boolean {
  if (mode === 'mobile') return false;
  return hasRoomForInlinePanel;
}
