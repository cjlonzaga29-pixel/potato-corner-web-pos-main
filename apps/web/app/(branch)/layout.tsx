'use client';

import type { ReactNode } from 'react';
import { BranchSidebar, BRANCH_NAV_ITEMS } from '@/components/branch/branch-sidebar';
import { BranchContextSync } from '@/components/branch/branch-context-sync';
import { DashboardHeader } from '@/components/shared/dashboard-header';
import { SocketInitializer } from '@/components/shared/socket-initializer';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { useAuth } from '@/hooks/use-auth';
import { useBranch } from '@/hooks/queries/use-branches';
import { useBranchStore } from '@/stores/branch.store';

/**
 * Task 209.54 — every branch-ops page reused from the supervisor tree
 * (inventory, cash, expenses, attendance, recipe-readiness, reports — see
 * BranchContextSync's own doc comment) reads its active branch from
 * useBranchStore, which BranchContextSync only seeds once useAuth's silent
 * refresh AND the useBranch(branchId) fetch it triggers both resolve. Until
 * then, `activeBranchId` is null, and every one of those pages independently
 * renders its own "Select an active branch" / "no branch" messaging — which
 * is correct for a supervisor who genuinely hasn't picked one, but was
 * misleading here: a correctly-staffed branch/staff account saw it flash on
 * every reload while that two-step sync was still in flight. Gating
 * `children` on that same readiness here, once, is a single choke point
 * that fixes every branch-ops page under this shell without touching the
 * shared components themselves (which supervisor pages reuse unmodified,
 * with their own legitimate "nothing selected yet" semantics intact).
 * Falls through to `children` (not stuck spinning) once the account is
 * confirmed to have no branch at all or the branch fetch errors — those are
 * real states the individual pages already handle.
 */
function useBranchContextReady(): boolean {
  const { user, isLoading: isAuthLoading } = useAuth();
  const branchId = user?.branchIds[0];
  const { isLoading: isBranchLoading, isError: isBranchError } = useBranch(branchId);
  const activeBranchId = useBranchStore((s) => s.activeBranchId);

  if (isAuthLoading) return false;
  if (!branchId) return true;
  if (isBranchError) return true;
  if (activeBranchId !== branchId && isBranchLoading) return false;
  return true;
}

/**
 * Branch shell — shared by both the `branch` role (full branch operations,
 * every item in BRANCH_NAV_ITEMS) and the `staff` role (cashiers, who see
 * only the POS Terminal/Shifts/Notifications/Receipts/Profile subset via
 * BranchSidebar's own role filtering). CR-003: the POS Terminal used to be
 * its own route group with its own shell (app/(pos)/layout.tsx) — it is now
 * just another page inside this one, at /branch/terminal.
 *
 * Branch is server-trusted here exactly as it was for the old (pos) shell:
 * the first (only) entry in the JWT's branch_ids, never a client-side
 * selection — both `branch` and `staff` accounts are bound to one branch,
 * so unlike the supervisor shell there is no BranchSelector in the sidebar.
 *
 * Everything else the old (pos) layout provided is preserved without
 * duplicating it here: SocketInitializer is still mounted once below;
 * offline detection is self-initializing (useOffline() registers its own
 * listeners wherever it's called, already called directly by the terminal
 * page). Shifts are auto-managed (Phase 4-9 shift removal) — opened on
 * Clock In and closed on Clock Out, with no cashier-facing Open/Close Shift
 * step; the old PosHeader's End Shift button was already dead code before
 * that change (no onEndShift handler was ever wired to it).
 *
 * There used to be a BranchSessionGuard here that redirected a `branch`
 * session away from /branch/terminal to a separate /branch/select-employee
 * route. Employee selection ("Who is working?") is now rendered inline by
 * the terminal page itself (STATE 1 of its state machine), so that redirect
 * — and the extra page hop it caused — is gone entirely. Task 120:
 * ROLE_DASHBOARDS now lands a `branch` login on /branch/dashboard like every
 * other role — /branch/select-employee is kept only as a redirect shim for
 * stale links, it is no longer part of the login flow.
 */
export default function BranchLayout({ children }: { children: ReactNode }) {
  const branchContextReady = useBranchContextReady();
  return (
    <div className="flex h-screen overflow-hidden bg-background print:hidden">
      <SocketInitializer />
      <BranchContextSync />
      <BranchSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader
          navItems={BRANCH_NAV_ITEMS}
          homeHref="/branch/dashboard"
          homeLabel="Branch"
          profileHref="/branch/profile"
          fallbackInitials="BR"
        />
        {/*
          `relative` lets a full-bleed page (currently only /branch/terminal)
          opt out of this padding/scroll box via `absolute inset-0` on its own
          root element — CSS positions an absolutely-positioned descendant
          against the padding edge, so it fills exactly this <main>'s box
          ignoring the padding, and this <main>'s own overflow-y-auto becomes
          inert for that page since nothing then overflows it. Every other
          route is unaffected — `relative` with no absolutely-positioned
          child changes nothing visually.
        */}
        <main className="app-page relative flex-1 overflow-y-auto overflow-x-hidden">
          {branchContextReady ? (
            children
          ) : (
            <div className="flex h-full items-center justify-center">
              <LoadingSpinner size="lg" />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
