import type { ReactNode } from 'react';
import { BranchSidebar, BRANCH_NAV_ITEMS } from '@/components/branch/branch-sidebar';
import { BranchContextSync } from '@/components/branch/branch-context-sync';
import { DashboardHeader } from '@/components/shared/dashboard-header';
import { SocketInitializer } from '@/components/shared/socket-initializer';

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
        <main className="app-page relative flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
