import type { ReactNode } from 'react';
import { AdminSidebar } from '@/components/admin/admin-sidebar';
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
    <div className="flex h-screen overflow-hidden">
      <SocketInitializer />
      <AdminSidebar />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
