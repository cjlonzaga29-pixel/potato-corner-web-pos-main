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
  Users,
  Clock,
  BarChart3,
  Bell,
  Settings,
  User,
  Receipt,
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
  /** Sidebar section header this item renders under. */
  group: 'Overview' | 'Inventory' | 'Products' | 'People' | 'Reports' | 'Settings';
}

/**
 * Full branch-role nav plus the narrow staff (cashier) subset. The POS
 * Terminal is not a separate app — it is just another item in this list,
 * same as every other branch-operations page (CR-003).
 *
 * Clock In / Out, Cash Management, Cash Reconciliation, Expenses, Analytics,
 * and Activity Logs are deliberately NOT separate top-level items:
 * - Clock In / Out lives inside POS Terminal itself (cashiers never need a
 *   separate page for it — see terminal/page.tsx).
 * - Expenses, Analytics, and Activity Logs are tabs inside Reports.
 * - Shift Summary and Cash Reconciliation are no longer primary Reports tabs
 *   (shifts are auto-managed server-side, not a branch operation — see
 *   shift-guard.ts). Their historical data is preserved read-only under
 *   Reports -> Activity Logs -> Historical Shift Records
 *   (historical-shift-records.tsx), not part of normal branch operations.
 */
export const BRANCH_NAV_ITEMS = [
  { label: 'Dashboard', href: '/branch/dashboard', icon: LayoutDashboard, group: 'Overview' },
  { label: 'POS Terminal', href: '/branch/terminal', icon: ShoppingCart, roles: ['branch', 'staff'], group: 'Overview' },
  { label: 'Sales', href: '/branch/sales', icon: TrendingUp, group: 'Overview' },

  { label: 'Inventory', href: '/branch/inventory', icon: Boxes, group: 'Inventory' },
  { label: 'Receiving', href: '/branch/inventory/stock-in', icon: PackagePlus, group: 'Inventory' },
  { label: 'Stock Movement', href: '/branch/inventory/movements', icon: ArrowLeftRight, group: 'Inventory' },
  { label: 'Stock Adjustments', href: '/branch/inventory/adjust', icon: SlidersHorizontal, group: 'Inventory' },
  { label: 'Waste Management', href: '/branch/inventory/waste', icon: Trash2, group: 'Inventory' },
  { label: 'Transfers', href: '/branch/inventory/transfer', icon: Truck, group: 'Inventory' },

  { label: 'Products', href: '/branch/products', icon: Package, group: 'Products' },

  { label: 'Employees', href: '/branch/employees', icon: Users, group: 'People' },
  { label: 'Attendance', href: '/branch/attendance', icon: Clock, group: 'People' },

  { label: 'Reports', href: '/branch/reports', icon: BarChart3, group: 'Reports' },

  { label: 'Branch Settings', href: '/branch/settings', icon: Settings, group: 'Settings' },
  { label: 'Notifications', href: '/branch/notifications', icon: Bell, roles: ['branch', 'staff'], group: 'Settings' },
  { label: 'Receipts', href: '/branch/receipts', icon: Receipt, roles: ['branch', 'staff'], group: 'Settings' },
  { label: 'Profile', href: '/branch/profile', icon: User, roles: ['branch', 'staff'], group: 'Settings' },
] satisfies ReadonlyArray<BranchNavItem>;

const GROUP_ORDER: BranchNavItem['group'][] = ['Overview', 'Inventory', 'Products', 'People', 'Reports', 'Settings'];

/** Items visible to the given role — undefined `roles` (or `roles: ['branch']`) means branch-only. */
export function branchNavItemsForRole(role: Role | undefined): BranchNavItem[] {
  if (!role) return [];
  const BRANCH_ONLY: Role[] = ['branch'];
  return BRANCH_NAV_ITEMS.filter((item) => (item.roles ?? BRANCH_ONLY).includes(role));
}

/** Groups the role-visible items under their section headers, in display order, dropping empty sections. */
export function branchNavGroupsForRole(role: Role | undefined): { group: string; items: BranchNavItem[] }[] {
  const items = branchNavItemsForRole(role);
  return GROUP_ORDER.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter(
    (section) => section.items.length > 0,
  );
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

  const navGroups = branchNavGroupsForRole(user?.role);

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

      <nav className="flex-1 space-y-4 overflow-y-auto p-2">
        <TooltipProvider delayDuration={200}>
          {navGroups.map(({ group, items }) => (
            <div key={group} className="space-y-1">
              {!collapsed && (
                <p className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{group}</p>
              )}
              {items.map((item) => {
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
            </div>
          ))}
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
