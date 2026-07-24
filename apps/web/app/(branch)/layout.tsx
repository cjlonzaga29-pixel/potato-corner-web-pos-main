import type { ReactNode } from 'react';
import { BranchSidebar, BRANCH_NAV_ITEMS } from '@/components/branch/branch-sidebar';
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
 * page); and the real "close out a shift" flow is the Shifts page's own
 * Close Shift button (/branch/shift -> /branch/shift/close), not the old
 * PosHeader's End Shift button, which was already dead code (no
 * onEndShift handler was ever wired to it).
 */
export default function BranchLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <SocketInitializer />
      <BranchSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader
          navItems={BRANCH_NAV_ITEMS}
          homeHref="/branch/dashboard"
          homeLabel="Branch"
          profileHref="/branch/profile"
          fallbackInitials="BR"
        />
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
