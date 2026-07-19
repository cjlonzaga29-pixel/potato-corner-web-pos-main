'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Clock } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useOffline } from '@/hooks/use-offline';
import { useBranch } from '@/hooks/queries/use-branches';
import { useShiftStore } from '@/stores/shift.store';
import { Button } from '@/components/ui/button';
import { NotificationBell } from '@/components/shared/notification-bell';
import { ShiftStatusIndicator } from './shift-status-indicator';
import { cn } from '@/lib/utils';

/** Starts null (not `new Date()`) so the server-rendered markup and first client render agree — see the login form's hydration fix for the same pattern. */
function useClock(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

interface PosHeaderProps {
  onEndShift?: () => void;
}

/** Minimal header for the POS terminal, not a sidebar. Every interactive element is touch-target sized for Android tablet in landscape. */
export function PosHeader({ onEndShift }: PosHeaderProps) {
  const { user } = useAuth();
  const { isOnline, pendingSyncCount } = useOffline();
  const isShiftOpen = useShiftStore((state) => state.isShiftOpen);
  const now = useClock();
  const branchId = user?.branchIds[0];
  const { data: branch, isLoading: isBranchLoading } = useBranch(branchId);
  const branchLabel = !branchId ? 'No branch' : isBranchLoading ? 'Loading…' : (branch?.name ?? 'Branch unavailable');

  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b bg-card px-4">
      <div className="flex items-center gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
          PC
        </div>
        <div>
          <p className="text-sm font-semibold">{branchLabel}</p>
          <p className="text-xs text-muted-foreground">
            {user ? `${user.firstName} ${user.lastName}`.trim() || user.email : 'Cashier'}
          </p>
        </div>
        <ShiftStatusIndicator />
      </div>

      <div className="flex items-center gap-4">
        <p className="hidden text-sm font-medium tabular-nums sm:block">
          {now ? now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '--:--:--'}
        </p>

        <div className="flex items-center gap-1.5 text-xs font-medium">
          <span className={cn('h-2.5 w-2.5 rounded-full', isOnline ? 'bg-green-500' : 'bg-orange-500')} aria-hidden="true" />
          {isOnline ? 'Online' : 'Offline'}
          {pendingSyncCount > 0 && (
            <span className="ml-1 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-800 dark:bg-orange-900/40 dark:text-orange-300">
              {pendingSyncCount} pending
            </span>
          )}
        </div>

        <NotificationBell />

        <Button variant="outline" className="touch-target" asChild>
          <Link href="/clock-in">
            <Clock className="mr-2 h-4 w-4" />
            Clock In/Out
          </Link>
        </Button>

        <Button variant="danger" className="touch-target" onClick={onEndShift} disabled={!isShiftOpen}>
          End Shift
        </Button>
      </div>
    </header>
  );
}
