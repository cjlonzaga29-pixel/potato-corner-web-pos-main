'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Package,
  Clock,
  Banknote,
  BarChart3,
  DollarSign,
  ChefHat,
  Palette,
  Users,
  Receipt,
  ClipboardList,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  Loader2,
} from 'lucide-react';
import { ROLE_LABELS } from '@potato-corner/shared';
import { cn, generateInitials } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useBranchStore } from '@/stores/branch.store';
import { useProductRequests } from '@/hooks/queries/use-product-requests';
import { useFlavorRequests } from '@/hooks/queries/use-flavor-requests';
import { usePriceOverrides } from '@/hooks/queries/use-price-overrides';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { NavLinkIcon } from '@/components/shared/nav-link-icon';
import type { NavItem } from '@/components/shared/nav-types';
import { BranchSelector } from './branch-selector';

export const SUPERVISOR_NAV_ITEMS = [
  { label: 'Dashboard', href: '/supervisor/dashboard', icon: LayoutDashboard },
  { label: 'Inventory', href: '/supervisor/inventory', icon: Package },
  { label: 'Attendance', href: '/supervisor/attendance', icon: Clock },
  { label: 'Cash Management', href: '/supervisor/cash', icon: Banknote },
  { label: 'Expenses', href: '/supervisor/expenses', icon: Receipt },
  { label: 'Employees', href: '/supervisor/employees', icon: Users },
  { label: 'Reports', href: '/supervisor/reports', icon: BarChart3 },
  // CR-001
  { label: 'Product Requests', href: '/supervisor/product-requests', icon: Package },
  // CR-002
  { label: 'Flavor Requests', href: '/supervisor/flavor-requests', icon: Palette },
  { label: 'Inventory Requests', href: '/supervisor/inventory-requests', icon: ClipboardList },
  { label: 'Price Overrides', href: '/supervisor/price-overrides', icon: DollarSign },
  { label: 'Recipes', href: '/supervisor/recipes', icon: ChefHat },
] satisfies ReadonlyArray<NavItem>;

export function SupervisorSidebar() {
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
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: myProductRequests } = useProductRequests({ status: 'pending', branch_id: activeBranchId ?? undefined, limit: 1 });
  const { data: myFlavorRequests } = useFlavorRequests({ status: 'pending', branch_id: activeBranchId ?? undefined, limit: 1 });
  const { data: myPriceOverrides } = usePriceOverrides({ status: 'pending', branch_id: activeBranchId ?? undefined, limit: 1 });
  const badgeCounts: Record<string, number> = {
    '/supervisor/product-requests': myProductRequests?.total ?? 0,
    '/supervisor/flavor-requests': myFlavorRequests?.total ?? 0,
    '/supervisor/price-overrides': myPriceOverrides?.total ?? 0,
  };

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
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-blue-700 text-sm font-bold text-primary-foreground shadow-glow">
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
            const count = badgeCounts[item.href] ?? 0;
            const showBadge = count > 0;
            const link = (
              <Link
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150',
                  isActive
                    ? 'bg-primary text-primary-foreground shadow-glow'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground',
                )}
              >
                <NavLinkIcon icon={item.icon} className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                {showBadge && (
                  <Badge variant={isActive ? 'secondary' : 'critical'} className="ml-auto px-1.5 py-0 text-[10px]">
                    {count}
                  </Badge>
                )}
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
              <AvatarFallback className="bg-gradient-to-br from-primary to-blue-700 text-xs font-semibold text-primary-foreground">
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
  );
}
