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
  Users,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
} from 'lucide-react';
import { ROLE_LABELS } from '@potato-corner/shared';
import { cn, generateInitials } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useBranchStore } from '@/stores/branch.store';
import { useProductRequests } from '@/hooks/queries/use-product-requests';
import { usePriceOverrides } from '@/hooks/queries/use-price-overrides';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NotificationBell } from '@/components/shared/notification-bell';
import { BranchSelector } from './branch-selector';

const NAV_ITEMS = [
  { label: 'Dashboard', href: '/supervisor/dashboard', icon: LayoutDashboard },
  { label: 'Inventory', href: '/supervisor/inventory', icon: Package },
  { label: 'Attendance', href: '/supervisor/attendance', icon: Clock },
  { label: 'Cash Management', href: '/supervisor/cash', icon: Banknote },
  { label: 'Employees', href: '/supervisor/employees', icon: Users },
  { label: 'Reports', href: '/supervisor/reports', icon: BarChart3 },
  // CR-001
  { label: 'Product Requests', href: '/supervisor/product-requests', icon: Package },
  { label: 'Price Overrides', href: '/supervisor/price-overrides', icon: DollarSign },
  { label: 'Recipe Overrides', href: '/supervisor/recipes', icon: ChefHat },
];

export function SupervisorSidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: myProductRequests } = useProductRequests({ status: 'pending', branch_id: activeBranchId ?? undefined, limit: 1 });
  const { data: myPriceOverrides } = usePriceOverrides({ status: 'pending', branch_id: activeBranchId ?? undefined, limit: 1 });
  const badgeCounts: Record<string, number> = {
    '/supervisor/product-requests': myProductRequests?.total ?? 0,
    '/supervisor/price-overrides': myPriceOverrides?.total ?? 0,
  };

  return (
    <aside className={cn('flex h-screen flex-col border-r bg-card transition-all duration-200', collapsed ? 'w-16' : 'w-64')}>
      <div className="flex h-14 items-center justify-between border-b px-3">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
              PC
            </div>
            <span className="text-sm font-semibold">Potato Corner</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <NotificationBell />
          <Button variant="ghost" size="icon" onClick={() => setCollapsed((prev) => !prev)} aria-label="Toggle sidebar">
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="border-b p-3">
          <BranchSelector />
        </div>
      )}

      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          const count = badgeCounts[item.href] ?? 0;
          const showBadge = count > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
              {showBadge && (
                <Badge variant={isActive ? 'secondary' : 'critical'} className="ml-auto px-1.5 py-0 text-[10px]">
                  {count}
                </Badge>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="border-t p-3">
        <div className={cn('flex items-center gap-3', collapsed && 'justify-center')}>
          <Avatar className="h-8 w-8">
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
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => void logout()}
            aria-label="Log out"
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </aside>
  );
}
