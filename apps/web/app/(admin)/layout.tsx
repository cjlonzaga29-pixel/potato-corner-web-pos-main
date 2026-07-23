import type { ReactNode } from 'react';
import { AdminSidebar, ADMIN_NAV_ITEMS } from '@/components/admin/admin-sidebar';
import { DashboardHeader } from '@/components/shared/dashboard-header';
import { SocketInitializer } from '@/components/shared/socket-initializer';

/**
 * Super Admin shell. Route-level access is already enforced by
 * middleware.ts before this layout renders — this shell only owns
 * presentation, not auth checks. TanStack Query is provided once at the
 * root (components/shared/providers.tsx), not re-created per layout —
 * a second QueryClientProvider here would fragment the cache between
 * route groups instead of sharing it.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <SocketInitializer />
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader
          navItems={ADMIN_NAV_ITEMS}
          homeHref="/admin/dashboard"
          homeLabel="Admin"
          profileHref="/admin/profile"
          fallbackInitials="AD"
        />
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
