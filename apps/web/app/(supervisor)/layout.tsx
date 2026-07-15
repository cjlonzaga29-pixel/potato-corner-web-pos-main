import type { ReactNode } from 'react';
import { SupervisorSidebar } from '@/components/supervisor/supervisor-sidebar';
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
    <div className="flex h-screen overflow-hidden">
      <SocketInitializer />
      <SupervisorSidebar />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
