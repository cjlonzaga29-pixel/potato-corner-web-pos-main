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
    <div className="flex h-screen overflow-hidden bg-background">
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
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
