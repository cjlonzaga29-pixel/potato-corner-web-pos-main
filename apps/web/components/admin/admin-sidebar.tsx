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
  Clock,
  Percent,
  Boxes,
  CalendarCheck,
  FileSearch,
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { NavLinkIcon } from '@/components/shared/nav-link-icon';
import type { NavItem } from '@/components/shared/nav-types';

/**
 * Route paths match the existing app/(admin)/admin/* folder structure
 * (established in Phase 0/2, e.g. apps/web/middleware.ts's
 * ROLE_PATH_OWNERSHIP), not the shorthand "/dashboard"-style paths — the
 * real routes are prefixed with /admin.
 */
export const ADMIN_NAV_ITEMS = [
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
      { label: 'Shifts', href: '/admin/reports?tab=SHIFT_SUMMARY', icon: Clock },
      { label: 'Fraud Alerts', href: '/admin/reports?tab=FRAUD_ALERT_SUMMARY', icon: ShieldAlert },
      { label: 'Discount Compliance', href: '/admin/reports?tab=DISCOUNT_COMPLIANCE', icon: Percent },
      { label: 'Inventory Movement', href: '/admin/reports?tab=INVENTORY_MOVEMENT', icon: Boxes },
      { label: 'Attendance Summary', href: '/admin/reports?tab=ATTENDANCE_SUMMARY', icon: CalendarCheck },
      { label: 'Audit Log', href: '/admin/reports?tab=AUDIT_LOG', icon: FileSearch },
    ],
  },
  { label: 'Settings', href: '/admin/settings', icon: Settings },
] satisfies ReadonlyArray<NavItem>;

/** Purely presentational grouping — a section label rendered above the nav item whose `label` is used as the key. */
const SECTION_LABELS: Record<string, string> = {
  Dashboard: 'Overview',
  Branches: 'Management',
  Employees: 'People',
  Settings: 'System',
};

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
        {ADMIN_NAV_ITEMS.map((item) => {
          const sectionLabel = SECTION_LABELS[item.label];
          const sectionHeading = sectionLabel && !collapsed ? (
            <p className="mb-1 mt-4 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 first:mt-1">
              {sectionLabel}
            </p>
          ) : null;

          if (item.children) {
            const childActive = item.children.some(
              (child) => pathname === child.href || pathname?.startsWith(`${child.href.split('?')[0]}/`),
            );
            const isOpen = openGroups[item.label] ?? childActive;
            const groupButton = (
              <button
                type="button"
                onClick={() => setOpenGroups((prev) => ({ ...prev, [item.label]: !isOpen }))}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150',
                  childActive
                    ? 'bg-primary/12 text-primary shadow-[inset_2px_0_0_0_hsl(var(--primary))]'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground',
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
            );
            return (
              <div key={item.label}>
                {sectionHeading}
                {collapsed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>{groupButton}</TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                ) : (
                  groupButton
                )}
                {isOpen && !collapsed && (
                  <div className="ml-4 mt-1 space-y-1 border-l border-border/60 pl-2">
                    {item.children.map((child) => {
                      const isActive = pathname === child.href || pathname?.startsWith(`${child.href.split('?')[0]}/`);
                      const count = badgeCounts[child.href] ?? 0;
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className={cn(
                            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150',
                            isActive
                              ? 'bg-primary text-primary-foreground shadow-glow'
                              : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground',
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
              {count > 0 && (
                <Badge variant={isActive ? 'secondary' : 'critical'} className="ml-auto px-1.5 py-0 text-[10px]">
                  {count}
                </Badge>
              )}
            </Link>
          );
          return (
            <div key={item.href}>
              {sectionHeading}
              {collapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              ) : (
                link
              )}
            </div>
          );
        })}
        </TooltipProvider>
      </nav>

      <div className="border-t border-border/60 p-3">
        <div className={cn('flex items-center gap-3 rounded-lg p-1.5 transition-colors hover:bg-accent/50', collapsed && 'justify-center')}>
          <Link href="/admin/profile" className="flex min-w-0 flex-1 items-center gap-3">
            <Avatar className="h-8 w-8 ring-2 ring-primary/20">
              <AvatarFallback className="bg-gradient-to-br from-primary to-primary/70 text-xs font-semibold text-primary-foreground">
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
