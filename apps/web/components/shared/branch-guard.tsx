'use client';

import type { ReactNode } from 'react';
import { useAuthStore } from '@/stores/auth.store';

interface BranchGuardProps {
  branchId: string;
  children: ReactNode;
}

/** Conditionally renders UI based on branch access. super_admin always renders children; not a security boundary — the API enforces access via branch-guard middleware. */
export function BranchGuard({ branchId, children }: BranchGuardProps) {
  const hasBranchAccess = useAuthStore((state) => state.hasBranchAccess);
  if (!hasBranchAccess(branchId)) {
    return null;
  }
  return <>{children}</>;
}
