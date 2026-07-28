'use client';

import { RecipeReadinessReport } from '@/components/shared/recipe-readiness/recipe-readiness-report';

/**
 * CR-011.2 — Admin-facing read-only Recipe/BOM readiness report ahead of the
 * CR-012 POS-deduction cutover. No mutation controls; ProductComponent
 * editing remains under Products.
 */
export default function AdminRecipeReadinessPage() {
  return <RecipeReadinessReport />;
}
