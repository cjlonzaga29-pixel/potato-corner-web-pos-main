'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Clock, LogOut, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useOffline } from '@/hooks/use-offline';
import { useBranch } from '@/hooks/queries/use-branches';
import { useShiftStore } from '@/stores/shift.store';
import { Button } from '@/components/ui/button';
import { NotificationBellConnected } from '@/components/shared/notification-bell-connected';
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
  const { user, logout } = useAuth();
  const { isOnline, pendingSyncCount } = useOffline();
  const isShiftOpen = useShiftStore((state) => state.isShiftOpen);
  const now = useClock();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await logout();
    } finally {
      setIsLoggingOut(false);
    }
  }
  const branchId = user?.branchIds[0];
  const { data: branch, isLoading: isBranchLoading } = useBranch(branchId);
  const branchLabel = !branchId ? 'No branch' : isBranchLoading ? 'Loading…' : (branch?.name ?? 'Branch unavailable');

  return (
    <header className="glass-panel flex h-16 shrink-0 items-center justify-between border-b px-4">
      <div className="flex items-center gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/70 text-sm font-bold text-primary-foreground shadow-glow">
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
          <span className={cn('h-2.5 w-2.5 rounded-full', isOnline ? 'bg-success' : 'bg-warning')} aria-hidden="true" />
          {isOnline ? 'Online' : 'Offline'}
          {pendingSyncCount > 0 && (
            <span className="ml-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
              {pendingSyncCount} pending
            </span>
          )}
        </div>

        <NotificationBellConnected />

        <Button variant="outline" className="touch-target" asChild>
          <Link href="/branch/clock-in">
            <Clock className="mr-2 h-4 w-4" />
            Clock In/Out
          </Link>
        </Button>

        <Button variant="danger" className="touch-target" onClick={onEndShift} disabled={!isShiftOpen}>
          End Shift
        </Button>

        <Button
          variant="outline"
          className="touch-target"
          onClick={() => void handleLogout()}
          disabled={isLoggingOut}
          aria-label="Log out"
        >
          {isLoggingOut ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogOut className="mr-2 h-4 w-4" />}
          Log Out
        </Button>
      </div>
    </header>
  );
}
