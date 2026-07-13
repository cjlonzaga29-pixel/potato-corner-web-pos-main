import type { ReactNode } from 'react';
import { PosHeader } from '@/components/pos/pos-header';
import { SocketInitializer } from '@/components/shared/socket-initializer';

/**
 * Full-screen POS shell — no scroll on the outer container; children fill
 * the remaining height below the header. Service worker registration is
 * handled by the @ducanh2912/next-pwa build plugin (next.config.ts), not
 * manually triggered here. Offline detection is initialized by PosHeader
 * itself (it calls useOffline() to drive its online/offline indicator),
 * so no separate initializer is needed for that.
 */
export default function PosLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <SocketInitializer />
      <PosHeader />
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
