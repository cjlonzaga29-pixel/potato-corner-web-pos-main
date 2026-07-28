'use client';

import { RecipeReadinessReport } from '@/components/shared/recipe-readiness/recipe-readiness-report';
import { useBranch } from '@/hooks/use-branch';

/**
 * CR-011.2 — Supervisor-facing read-only Recipe/BOM readiness report.
 * Supervisor access is org-wide per lib/branch-access.ts (not assignment
 * scoped) — this page filters the shared report down to whichever branch is
 * currently active in the sidebar's BranchSelector, matching the pattern
 * every other supervisor page already follows. It does not grant supervisor
 * any access the API doesn't already allow.
 */
export default function SupervisorRecipeReadinessPage() {
  const { activeBranchId } = useBranch();
  return <RecipeReadinessReport branchId={activeBranchId ?? undefined} />;
}
