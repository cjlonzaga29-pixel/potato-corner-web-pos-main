'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Package,
  ShoppingBag,
  Clock,
  Banknote,
  BarChart3,
  Users,
  Receipt,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  Loader2,
  ClipboardList,
  Settings,
} from 'lucide-react';
import { ROLE_LABELS } from '@potato-corner/shared';
import { cn, generateInitials } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useUiStore } from '@/stores/ui.store';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { NavLinkIcon } from '@/components/shared/nav-link-icon';
import type { NavItem } from '@/components/shared/nav-types';
import { BranchSelector } from './branch-selector';

export const SUPERVISOR_NAV_ITEMS = [
  { label: 'Dashboard', href: '/supervisor/dashboard', icon: LayoutDashboard },
  { label: 'Inventory', href: '/supervisor/inventory', icon: Package },
  { label: 'Products', href: '/supervisor/products', icon: ShoppingBag },
  { label: 'Recipe Readiness', href: '/supervisor/recipe-readiness', icon: ClipboardList },
  { label: 'Attendance', href: '/supervisor/attendance', icon: Clock },
  { label: 'Cash Management', href: '/supervisor/cash', icon: Banknote },
  { label: 'Expenses', href: '/supervisor/expenses', icon: Receipt },
  { label: 'Employees', href: '/supervisor/employees', icon: Users },
  { label: 'Reports', href: '/supervisor/reports', icon: BarChart3 },
  { label: 'Settings', href: '/supervisor/settings', icon: Settings },
] satisfies ReadonlyArray<NavItem>;

export function SupervisorSidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const isMobileNavOpen = useUiStore((state) => state.isMobileNavOpen);
  const setMobileNavOpen = useUiStore((state) => state.setMobileNavOpen);

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await logout();
    } finally {
      setIsLoggingOut(false);
    }
  }
  return (
    <>
    <aside
      className="glass-panel hidden h-screen flex-col border-r transition-all duration-200 lg:flex"
      style={{ width: collapsed ? 'var(--app-sidebar-collapsed-width)' : 'var(--app-sidebar-width)' }}
    >
      <div
        className="flex items-center justify-between border-b border-border/60 px-3"
        style={{ height: 'var(--app-header-height)' }}
      >
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
              PC
            </div>
            <span className="text-sm font-semibold tracking-tight">Potato Corner</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="rounded-lg"
            onClick={() => setCollapsed((prev) => !prev)}
            aria-label="Toggle sidebar"
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="border-b border-border/60 p-3">
          <BranchSelector />
        </div>
      )}

      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        <TooltipProvider delayDuration={200}>
          {SUPERVISOR_NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
            const link = (
              <Link
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-all duration-150',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <NavLinkIcon icon={item.icon} className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
              </Link>
            );
            return collapsed ? (
              <Tooltip key={item.href}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            ) : (
              <div key={item.href}>{link}</div>
            );
          })}
        </TooltipProvider>
      </nav>

      <div className="border-t border-border/60 p-3">
        <div className={cn('flex items-center gap-3 rounded-lg p-1.5 transition-colors hover:bg-accent/50', collapsed && 'justify-center')}>
          <Link href="/supervisor/profile" className="flex min-w-0 flex-1 items-center gap-3">
            <Avatar className="h-8 w-8 ring-2 ring-primary/20">
              <AvatarFallback className="bg-primary text-xs font-semibold text-primary-foreground">
                {user ? generateInitials(user.firstName || 'S', user.lastName || 'V') : 'SV'}
              </AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {user ? `${user.firstName} ${user.lastName}`.trim() || user.email : 'Account'}
                </p>
                <p className="truncate text-xs text-muted-foreground">{user ? ROLE_LABELS[user.role] : ''}</p>
              </div>
            )}
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => void handleLogout()}
            disabled={isLoggingOut}
            aria-label="Log out"
          >
            {isLoggingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </aside>

    <Sheet open={isMobileNavOpen} onOpenChange={setMobileNavOpen}>
      <SheetContent side="left" className="flex w-72 max-w-[85vw] flex-col gap-0 p-0 lg:hidden">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <div className="flex h-16 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            PC
          </div>
          <span className="text-sm font-semibold tracking-tight">Potato Corner</span>
        </div>

        <div className="shrink-0 border-b border-border/60 p-3">
          <BranchSelector />
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-2">
          {SUPERVISOR_NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileNavOpen(false)}
                className={cn(
                  'flex min-h-11 items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-all duration-150',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <NavLinkIcon icon={item.icon} className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="shrink-0 border-t border-border/60 p-3">
          <div className="flex items-center gap-3 rounded-lg p-1.5">
            <Link
              href="/supervisor/profile"
              onClick={() => setMobileNavOpen(false)}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <Avatar className="h-8 w-8 ring-2 ring-primary/20">
                <AvatarFallback className="bg-primary text-xs font-semibold text-primary-foreground">
                  {user ? generateInitials(user.firstName || 'S', user.lastName || 'V') : 'SV'}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {user ? `${user.firstName} ${user.lastName}`.trim() || user.email : 'Account'}
                </p>
                <p className="truncate text-xs text-muted-foreground">{user ? ROLE_LABELS[user.role] : ''}</p>
              </div>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 shrink-0"
              onClick={() => void handleLogout()}
              disabled={isLoggingOut}
              aria-label="Log out"
            >
              {isLoggingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
    </>
  );
}
