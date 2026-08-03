'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Building2,
  ShoppingBag,
  Users,
  ClipboardCheck,
  BarChart3,
  Settings,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  LogOut,
  Loader2,
  Wallet,
  Boxes,
  Tags,
  Ruler,
  ListTree,
  SlidersHorizontal,
  ClipboardList,
} from 'lucide-react';
import { ROLE_LABELS } from '@potato-corner/shared';
import { cn, generateInitials } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
  {
    label: 'Product Creation',
    icon: ShoppingBag,
    children: [
      { label: 'Products', href: '/admin/products', icon: ShoppingBag },
      { label: 'Product Categories', href: '/admin/product-categories', icon: ListTree },
      { label: 'Product Options', href: '/admin/product-options', icon: SlidersHorizontal },
      { label: 'Universal Inventory', href: '/admin/inventory', icon: Boxes },
      { label: 'Inventory Categories', href: '/admin/inventory/categories', icon: Tags },
      { label: 'Units', href: '/admin/inventory/units', icon: Ruler },
      { label: 'Recipe Readiness', href: '/admin/recipe-readiness', icon: ClipboardList },
    ],
  },
  { label: 'Employees', href: '/admin/employees', icon: Users },
  { label: 'Attendance', href: '/admin/attendance', icon: ClipboardCheck },
  { label: 'Reports', href: '/admin/reports', icon: BarChart3 },
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
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  function isChildActive(children: ReadonlyArray<{ href: string }>) {
    return children.some((child) => pathname === child.href || pathname?.startsWith(`${child.href}/`));
  }

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await logout();
    } finally {
      setIsLoggingOut(false);
    }
  }
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
            const groupActive = isChildActive(item.children);
            const expanded = expandedGroups[item.label] ?? groupActive;

            if (collapsed) {
              const firstChildHref = item.children[0]?.href ?? '#';
              const collapsedLink = (
                <Link
                  href={firstChildHref}
                  className={cn(
                    'flex items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-all duration-150',
                    groupActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <NavLinkIcon icon={item.icon} className="h-4 w-4 shrink-0" />
                </Link>
              );
              return (
                <div key={item.label}>
                  {sectionHeading}
                  <Tooltip>
                    <TooltipTrigger asChild>{collapsedLink}</TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                </div>
              );
            }

            return (
              <div key={item.label}>
                {sectionHeading}
                <button
                  type="button"
                  onClick={() => setExpandedGroups((prev) => ({ ...prev, [item.label]: !expanded }))}
                  aria-expanded={expanded}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-all duration-150',
                    groupActive
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <NavLinkIcon icon={item.icon} className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate text-left">{item.label}</span>
                  <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform duration-150', expanded && 'rotate-180')} />
                </button>
                {expanded && (
                  <div className="ml-4 space-y-1 border-l border-border/60 pl-3">
                    {item.children.map((child) => {
                      const childActive = pathname === child.href || pathname?.startsWith(`${child.href}/`);
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          className={cn(
                            'flex items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-all duration-150',
                            childActive
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                          )}
                        >
                          <NavLinkIcon icon={child.icon} className="h-4 w-4 shrink-0" />
                          <span className="flex-1 truncate">{child.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          const link = (
            <Link
              href={item.href as string}
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
          return (
            <div key={item.label}>
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
