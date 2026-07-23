'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutGrid, Clock, Receipt, Timer, Store } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { PosHeader } from '@/components/pos/pos-header';
import { SocketInitializer } from '@/components/shared/socket-initializer';
import { NavLinkIcon } from '@/components/shared/nav-link-icon';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { cn } from '@/lib/utils';

const POS_NAV_ITEMS = [
  { label: 'Terminal', href: '/terminal', icon: LayoutGrid },
  { label: 'Shift', href: '/shift', icon: Timer },
  { label: 'Clock In', href: '/clock-in', icon: Clock },
  { label: 'Receipts', href: '/receipts', icon: Receipt },
];

/**
 * Full-screen POS shell — no scroll on the outer container; children fill
 * the remaining height below the header. Service worker registration is
 * handled by the @ducanh2912/next-pwa build plugin (next.config.ts), not
 * manually triggered here. Offline detection is initialized by PosHeader
 * itself (it calls useOffline() to drive its online/offline indicator),
 * so no separate initializer is needed for that.
 *
 * Branch is server-trusted: it's the first (only) entry in the staff JWT's
 * branch_ids, never a client-side selection — staff are bound to one branch
 * and there is no switcher here (contrast the supervisor's BranchSelector).
 */
export default function PosLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const branchId = user?.branchIds[0];

  if (!branchId) {
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        <SocketInitializer />
        <PosHeader />
        <main className="flex flex-1 items-center justify-center overflow-hidden">
          <EmptyState
            icon={Store}
            title="No branch assigned"
            description="Contact your supervisor to get staffed to a branch."
          />
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <SocketInitializer />
      <PosHeader />
      <nav className="flex shrink-0 items-center gap-1 border-b bg-card px-4 py-2">
        {POS_NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'touch-target flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <NavLinkIcon icon={item.icon} className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
