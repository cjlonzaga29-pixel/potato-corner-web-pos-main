'use client';

import type { ReactNode } from 'react';
import type { Role } from '@potato-corner/shared';
import { useAuthStore } from '@/stores/auth.store';

interface RoleGuardProps {
  allowedRoles: Role[];
  children: ReactNode;
  fallback?: ReactNode;
}

/** Conditionally renders UI based on the current user's role. Not a security boundary — the API enforces access; this only controls what's shown. */
export function RoleGuard({ allowedRoles, children, fallback = null }: RoleGuardProps) {
  const role = useAuthStore((state) => state.user?.role);
  if (!role || !allowedRoles.includes(role)) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
