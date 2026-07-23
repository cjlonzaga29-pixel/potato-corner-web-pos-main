'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Building2,
  ShoppingBag,
  Palette,
  ChefHat,
  Package,
  DollarSign,
  Users,
  ClipboardCheck,
  BarChart3,
  Receipt,
  Settings,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  LogOut,
  Loader2,
  Wallet,
  ShieldCheck,
  ShieldAlert,
  FileClock,
  Clock,
} from 'lucide-react';
import { ROLE_LABELS } from '@potato-corner/shared';
import { cn, generateInitials } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useProductRequests } from '@/hooks/queries/use-product-requests';
import { useFlavorRequests } from '@/hooks/queries/use-flavor-requests';
import { usePriceOverrides } from '@/hooks/queries/use-price-overrides';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NotificationBellConnected } from '@/components/shared/notification-bell-connected';
import { NavLinkIcon } from '@/components/shared/nav-link-icon';

/**
 * Route paths match the existing app/(admin)/admin/* folder structure
 * (established in Phase 0/2, e.g. apps/web/middleware.ts's
 * ROLE_PATH_OWNERSHIP), not the shorthand "/dashboard"-style paths — the
 * real routes are prefixed with /admin.
 */
const NAV_ITEMS = [
  { label: 'Dashboard', href: '/admin/dashboard', icon: LayoutDashboard },
  { label: 'Branches', href: '/admin/branches', icon: Building2 },
  { label: 'Branch Accounts', href: '/admin/branch-accounts', icon: Users },
  { label: 'Payment Settings', href: '/admin/payments', icon: Wallet },
  { label: 'Products', href: '/admin/products', icon: ShoppingBag },
  { label: 'Flavors', href: '/admin/flavors', icon: Palette },
  { label: 'Master Recipes', href: '/admin/recipes', icon: ChefHat },
  {
    label: 'Approvals',
    icon: ShieldCheck,
    children: [
      { label: 'Product Requests', href: '/admin/approvals/product-requests', icon: Package },
      { label: 'Flavor Requests', href: '/admin/approvals/flavor-requests', icon: Palette },
      { label: 'Price Overrides', href: '/admin/approvals/price-overrides', icon: DollarSign },
    ],
  },
  { label: 'Employees', href: '/admin/employees', icon: Users },
  { label: 'Attendance', href: '/admin/attendance', icon: ClipboardCheck },
  {
    label: 'Reports',
    icon: BarChart3,
    children: [
      { label: 'Financial', href: '/admin/reports', icon: BarChart3 },
      { label: 'Expenses', href: '/admin/expenses', icon: Receipt },
      { label: 'Shifts', href: '/admin/shifts', icon: Clock },
      { label: 'Fraud Alerts', href: '/admin/reports?tab=FRAUD_ALERT_SUMMARY', icon: ShieldAlert },
      { label: 'Audit Logs', href: '/admin/reports?tab=AUDIT_LOGS', icon: FileClock },
    ],
  },
  { label: 'Settings', href: '/admin/settings', icon: Settings },
];

export function AdminSidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await logout();
    } finally {
      setIsLoggingOut(false);
    }
  }
  const { data: pendingProductRequests } = useProductRequests({ status: 'pending', limit: 1 });
  const { data: pendingFlavorRequests } = useFlavorRequests({ status: 'pending', limit: 1 });
  const { data: pendingPriceOverrides } = usePriceOverrides({ status: 'pending', limit: 1 });
  const badgeCounts: Record<string, number> = {
    '/admin/approvals/product-requests': pendingProductRequests?.total ?? 0,
    '/admin/approvals/flavor-requests': pendingFlavorRequests?.total ?? 0,
    '/admin/approvals/price-overrides': pendingPriceOverrides?.total ?? 0,
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
          <NotificationBellConnected />
          <Button variant="ghost" size="icon" onClick={() => setCollapsed((prev) => !prev)} aria-label="Toggle sidebar">
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {NAV_ITEMS.map((item) => {
          if (item.children) {
            const childActive = item.children.some(
              (child) => pathname === child.href || pathname?.startsWith(`${child.href.split('?')[0]}/`),
            );
            const isOpen = openGroups[item.label] ?? childActive;
            return (
              <div key={item.label}>
                <button
                  type="button"
                  title={collapsed ? item.label : undefined}
                  onClick={() => setOpenGroups((prev) => ({ ...prev, [item.label]: !isOpen }))}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    childActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <NavLinkIcon icon={item.icon} className="h-4 w-4 shrink-0" />
                  {!collapsed && (
                    <>
                      <span className="flex-1 truncate text-left">{item.label}</span>
                      <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', isOpen && 'rotate-180')} />
                    </>
                  )}
                </button>
                {isOpen && !collapsed && (
                  <div className="ml-4 mt-1 space-y-1 border-l pl-2">
                    {item.children.map((child) => {
                      const isActive = pathname === child.href || pathname?.startsWith(`${child.href.split('?')[0]}/`);
                      const count = badgeCounts[child.href] ?? 0;
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className={cn(
                            'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                            isActive
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                          )}
                        >
                          <NavLinkIcon icon={child.icon} className="h-4 w-4 shrink-0" />
                          <span className="flex-1 truncate">{child.label}</span>
                          {count > 0 && (
                            <Badge variant={isActive ? 'secondary' : 'critical'} className="ml-auto px-1.5 py-0 text-[10px]">
                              {count}
                            </Badge>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          const count = badgeCounts[item.href] ?? 0;
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
              <NavLinkIcon icon={item.icon} className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
              {count > 0 && (
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
          <Link href="/admin/profile" className="flex min-w-0 flex-1 items-center gap-3">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-primary text-xs font-semibold text-primary-foreground">
                {user ? generateInitials(user.firstName || 'A', user.lastName || 'D') : 'AD'}
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
