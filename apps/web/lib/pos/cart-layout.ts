import type { DensityMode } from '@/hooks/use-density-mode';

/**
 * Task 200 (adaptive density engine) — replaces the terminal page's old
 * width-only `useIsDesktop()` split between the inline cart/checkout panel
 * and the mobile "View Cart" Sheet. Pure and unit-testable in isolation
 * (see cart-layout.test.ts) so this decision doesn't require a full page
 * render to verify.
 *
 * - mobile: always the Sheet — no viewport room for a persistent side panel.
 * - compact-touch: touch input, but width varies a lot (a 1024px+ touch
 *   laptop/2-in-1 has room for an inline panel; a narrower tablet doesn't) —
 *   `hasRoomForInlinePanel` (the terminal page's existing >=1024px check)
 *   decides.
 * - comfortable / standard / compact: fine-pointer desktop/laptop — always
 *   inline, same as before this task.
 */
export function shouldShowInlineCart(mode: DensityMode, hasRoomForInlinePanel: boolean): boolean {
  if (mode === 'mobile') return false;
  if (mode === 'compact-touch') return hasRoomForInlinePanel;
  return true;
}
