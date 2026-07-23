'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { LogOut, User } from 'lucide-react';
import { ROLE_LABELS } from '@potato-corner/shared';
import { generateInitials } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NotificationBellConnected } from '@/components/shared/notification-bell-connected';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { ADMIN_NAV_ITEMS } from '@/components/admin/admin-sidebar';
import { AdminSearchCommand } from '@/components/admin/admin-search-command';

function useBreadcrumbLabel(pathname: string | null): string {
  if (!pathname) return 'Dashboard';
  for (const item of ADMIN_NAV_ITEMS) {
    if (item.href === pathname) return item.label;
    for (const child of item.children ?? []) {
      if (child.href.split('?')[0] === pathname) return `${item.label} / ${child.label}`;
    }
  }
  const lastSegment = pathname.split('/').filter(Boolean).pop() ?? 'dashboard';
  return lastSegment
    .split('-')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ');
}

/** Persistent top bar for the admin shell — page identity + global actions, distinct from the sidebar's navigation role. */
export function AdminHeader() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const label = useBreadcrumbLabel(pathname);

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-border/60 bg-card/60 px-4 backdrop-blur-xl lg:px-6">
      <Breadcrumb className="hidden min-w-0 sm:block">
        <BreadcrumbList className="flex-nowrap">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/admin/dashboard">Admin</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="truncate">{label}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex-1 sm:max-w-sm">
        <AdminSearchCommand />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <ThemeToggle />
        <NotificationBellConnected />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="ml-1 flex items-center gap-2 rounded-lg p-1 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Account menu"
            >
              <Avatar className="h-8 w-8 ring-2 ring-primary/20">
                <AvatarFallback className="bg-gradient-to-br from-primary to-blue-700 text-xs font-semibold text-primary-foreground">
                  {user ? generateInitials(user.firstName || 'A', user.lastName || 'D') : 'AD'}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <p className="truncate text-sm font-medium">
                {user ? `${user.firstName} ${user.lastName}`.trim() || user.email : 'Account'}
              </p>
              <p className="truncate text-xs text-muted-foreground">{user ? ROLE_LABELS[user.role] : ''}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/admin/profile">
                <User className="mr-2 h-4 w-4" /> Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void logout()}>
              <LogOut className="mr-2 h-4 w-4" /> Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
