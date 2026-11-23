import type { ReactNode } from 'react';
import { SupervisorSidebar, SUPERVISOR_NAV_ITEMS } from '@/components/supervisor/supervisor-sidebar';
import { DashboardHeader } from '@/components/shared/dashboard-header';
import { SocketInitializer } from '@/components/shared/socket-initializer';

/**
 * Supervisor shell. Active-branch context comes from the Zustand
 * useBranchStore (apps/web/stores/branch.store.ts) — Zustand stores are
 * globally accessible without a React context provider wrapper, so no
 * separate "branch provider" component is needed here. TanStack Query is
 * provided once at the root (components/shared/providers.tsx).
 */
export default function SupervisorLayout({ children }: { children: ReactNode }) {
  return (
    // Same shell sizing as (branch)/layout.tsx: <main> is the page's only vertical
    // scroller, and `relative` makes it the containing block for absolutely
    // positioned descendants (e.g. every row's `sr-only` badge text). Without it
    // they resolve against the viewport and stretch the document, adding a
    // second scrollbar that slides the header and sidebar away. dvh keeps the
    // shell to the visible viewport on mobile browsers.
    <div className="flex h-screen overflow-hidden bg-background print:hidden supports-[height:100dvh]:h-[100dvh]">
      <SocketInitializer />
      <SupervisorSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader
          navItems={SUPERVISOR_NAV_ITEMS}
          homeHref="/supervisor/dashboard"
          homeLabel="Supervisor"
          profileHref="/supervisor/profile"
          fallbackInitials="SV"
        />
        <main className="app-page relative flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
