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
  ChevronDown,
  LogOut,
  Loader2,
  ClipboardList,
  Settings,
  ListTree,
  SlidersHorizontal,
  Boxes,
  Tags,
  Ruler,
  History,
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

/**
 * POS-PERF-P35 — "Catalog Setup" group added for the modules moved here
 * from Admin: Product Categories, Product Options, Universal Inventory,
 * Inventory Categories, Units. Inventory Movements reuses the existing
 * `/supervisor/inventory/movements` page (reachable from the Inventory
 * item's own stock-ops hub) rather than duplicating it here. Products and
 * Recipe Readiness stay as their existing top-level items, unchanged.
 */
export const SUPERVISOR_NAV_ITEMS: ReadonlyArray<NavItem> = [
  { label: 'Dashboard', href: '/supervisor/dashboard', icon: LayoutDashboard },
  { label: 'Inventory', href: '/supervisor/inventory', icon: Package },
  { label: 'Products', href: '/supervisor/products', icon: ShoppingBag },
  {
    label: 'Catalog Setup',
    icon: ListTree,
    children: [
      { label: 'Product Categories', href: '/supervisor/product-categories', icon: ListTree },
      { label: 'Product Options', href: '/supervisor/product-options', icon: SlidersHorizontal },
      { label: 'Universal Inventory', href: '/supervisor/inventory-catalog', icon: Boxes },
      { label: 'Inventory Categories', href: '/supervisor/inventory-catalog/categories', icon: Tags },
      { label: 'Units', href: '/supervisor/inventory-catalog/units', icon: Ruler },
      { label: 'Inventory Movements', href: '/supervisor/inventory/movements', icon: History },
    ],
  },
  { label: 'Recipe Readiness', href: '/supervisor/recipe-readiness', icon: ClipboardList },
  { label: 'Attendance', href: '/supervisor/attendance', icon: Clock },
  { label: 'Cash Management', href: '/supervisor/cash', icon: Banknote },
  { label: 'Expenses', href: '/supervisor/expenses', icon: Receipt },
  { label: 'Employees', href: '/supervisor/employees', icon: Users },
  { label: 'Reports', href: '/supervisor/reports', icon: BarChart3 },
  { label: 'Settings', href: '/supervisor/settings', icon: Settings },
];

export function SupervisorSidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const isMobileNavOpen = useUiStore((state) => state.isMobileNavOpen);
  const setMobileNavOpen = useUiStore((state) => state.setMobileNavOpen);

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
            if (item.children) {
              const groupActive = isChildActive(item.children);
              const expanded = expandedGroups[item.label] ?? groupActive;

              if (collapsed) {
                const firstChildHref = item.children[0]?.href ?? '#';
                const collapsedLink = (
                  <Link
                    href={firstChildHref}
                    prefetch={false}
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
                  <Tooltip key={item.label}>
                    <TooltipTrigger asChild>{collapsedLink}</TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                );
              }

              return (
                <div key={item.label}>
                  <button
                    type="button"
                    onClick={() => setExpandedGroups((prev) => ({ ...prev, [item.label]: !expanded }))}
                    aria-expanded={expanded}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-all duration-150',
                      groupActive
                        ? 'font-semibold text-foreground'
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
                            prefetch={false}
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
                prefetch={false}
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
            if (item.children) {
              const groupActive = isChildActive(item.children);
              return (
                <div key={item.label}>
                  <p
                    className={cn(
                      'flex min-h-11 items-center gap-3 rounded-full px-3 py-2 text-sm font-semibold',
                      groupActive ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <NavLinkIcon icon={item.icon} className="h-4 w-4 shrink-0" />
                    {item.label}
                  </p>
                  <div className="ml-4 space-y-1 border-l border-border/60 pl-3">
                    {item.children.map((child) => {
                      const childActive = pathname === child.href || pathname?.startsWith(`${child.href}/`);
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          prefetch={false}
                          onClick={() => setMobileNavOpen(false)}
                          className={cn(
                            'flex min-h-11 items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-all duration-150',
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
                </div>
              );
            }

            const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href as string}
                prefetch={false}
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
