'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  ShoppingCart,
  TrendingUp,
  Package,
  Boxes,
  PackagePlus,
  ArrowLeftRight,
  SlidersHorizontal,
  Trash2,
  Truck,
  ChefHat,
  Users,
  Clock,
  Timer,
  Banknote,
  Calculator,
  Receipt,
  BarChart3,
  LineChart,
  History,
  Bell,
  Settings,
  User,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  Loader2,
} from 'lucide-react';
import { ROLE_LABELS, type Role } from '@potato-corner/shared';
import { cn, generateInitials } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { NavLinkIcon } from '@/components/shared/nav-link-icon';
import type { NavItem } from '@/components/shared/nav-types';

interface BranchNavItem extends NavItem {
  /** Which roles see this item. Omitted (or `['branch']`) means branch-only; staff only ever sees the explicitly-listed subset. */
  roles?: Role[];
}

/**
 * Full branch-role nav plus the narrow staff (cashier) subset. The POS
 * Terminal is not a separate app — it is just another item in this list,
 * same as every other branch-operations page (CR-003).
 */
export const BRANCH_NAV_ITEMS = [
  { label: 'Dashboard', href: '/branch/dashboard', icon: LayoutDashboard },
  { label: 'POS Terminal', href: '/branch/terminal', icon: ShoppingCart, roles: ['branch', 'staff'] },
  { label: 'Sales', href: '/branch/sales', icon: TrendingUp },
  { label: 'Products', href: '/branch/products', icon: Package },
  { label: 'Inventory', href: '/branch/inventory', icon: Boxes },
  { label: 'Receiving', href: '/branch/inventory/stock-in', icon: PackagePlus },
  { label: 'Stock Movement', href: '/branch/inventory/movements', icon: ArrowLeftRight },
  { label: 'Stock Adjustments', href: '/branch/inventory/adjust', icon: SlidersHorizontal },
  { label: 'Waste Management', href: '/branch/inventory/waste', icon: Trash2 },
  { label: 'Transfers', href: '/branch/inventory/transfer', icon: Truck },
  { label: 'Master Recipes', href: '/branch/recipes', icon: ChefHat },
  { label: 'Employees', href: '/branch/employees', icon: Users },
  { label: 'Attendance', href: '/branch/attendance', icon: Clock },
  { label: 'Shifts', href: '/branch/shift', icon: Timer, roles: ['branch', 'staff'] },
  { label: 'Cash Management', href: '/branch/cash', icon: Banknote },
  { label: 'Cash Reconciliation', href: '/branch/cash/reconciliation', icon: Calculator },
  { label: 'Expenses', href: '/branch/expenses', icon: Receipt },
  { label: 'Reports', href: '/branch/reports', icon: BarChart3 },
  { label: 'Analytics', href: '/branch/analytics', icon: LineChart },
  { label: 'Activity Logs', href: '/branch/activity-logs', icon: History },
  { label: 'Notifications', href: '/branch/notifications', icon: Bell, roles: ['branch', 'staff'] },
  { label: 'Branch Settings', href: '/branch/settings', icon: Settings },
  { label: 'Receipts', href: '/branch/receipts', icon: Receipt, roles: ['branch', 'staff'] },
  { label: 'Profile', href: '/branch/profile', icon: User, roles: ['branch', 'staff'] },
] satisfies ReadonlyArray<BranchNavItem>;

/** Items visible to the given role — undefined `roles` (or `roles: ['branch']`) means branch-only. */
export function branchNavItemsForRole(role: Role | undefined): BranchNavItem[] {
  if (!role) return [];
  const BRANCH_ONLY: Role[] = ['branch'];
  return BRANCH_NAV_ITEMS.filter((item) => (item.roles ?? BRANCH_ONLY).includes(role));
}

export function BranchSidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await logout();
    } finally {
      setIsLoggingOut(false);
    }
  }

  const visibleItems = branchNavItemsForRole(user?.role);

  return (
    <aside
      className={cn(
        'glass-panel flex h-screen flex-col border-r transition-all duration-200',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      <div className="flex h-16 items-center justify-between border-b border-border/60 px-3">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/70 text-sm font-bold text-primary-foreground shadow-glow">
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

      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        <TooltipProvider delayDuration={200}>
          {visibleItems.map((item) => {
            const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
            const link = (
              <Link
                href={item.href ?? '#'}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150',
                  isActive
                    ? 'bg-primary text-primary-foreground shadow-glow'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground',
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
          <Link href="/branch/profile" className="flex min-w-0 flex-1 items-center gap-3">
            <Avatar className="h-8 w-8 ring-2 ring-primary/20">
              <AvatarFallback className="bg-gradient-to-br from-primary to-primary/70 text-xs font-semibold text-primary-foreground">
                {user ? generateInitials(user.firstName || 'B', user.lastName || 'R') : 'BR'}
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
  );
}
