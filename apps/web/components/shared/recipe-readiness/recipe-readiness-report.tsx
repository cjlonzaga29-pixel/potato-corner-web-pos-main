'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useRecipeReadiness, type ReadinessStatus, type VariantReadinessResponse } from '@/hooks/queries/use-recipe-readiness';

const STATUS_LABELS: Record<ReadinessStatus, string> = {
  READY: 'Ready',
  NO_RECIPE: 'No Recipe',
  INVALID_COMPONENT: 'Invalid Component',
  UNRESOLVED_MAPPING: 'Unresolved Mapping',
  INCOMPLETE_BRANCH_STOCK: 'Incomplete Branch Stock',
  BACKFILL_CONFLICT: 'Backfill Conflict',
  LEGACY_FLAVOR_DEPENDENCY: 'Legacy Flavor Dependency',
  INACTIVE: 'Inactive',
};

function badgeVariantForStatus(status: ReadinessStatus): 'active' | 'critical' | 'warning' | 'inactive' {
  if (status === 'READY') return 'active';
  if (status === 'INACTIVE') return 'inactive';
  if (status === 'NO_RECIPE' || status === 'INVALID_COMPONENT') return 'critical';
  return 'warning';
}

function VariantCard({ variant }: { variant: VariantReadinessResponse }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {variant.product_name} — {variant.variant_name} ({variant.size_label})
          </p>
          <p className="text-xs text-muted-foreground">variant: {variant.product_variant_id}</p>
        </div>
        <Badge variant={badgeVariantForStatus(variant.status)}>{STATUS_LABELS[variant.status]}</Badge>
      </div>
      {variant.blockers.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {variant.blockers.map((blocker, i) => (
            <li key={i}>
              • {blocker.message}
              {blocker.branch_ids.length > 0 && <span> (branches: {blocker.branch_ids.join(', ')})</span>}
              {blocker.inventory_item_ids.length > 0 && <span> (items: {blocker.inventory_item_ids.join(', ')})</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface RecipeReadinessReportProps {
  /** Restricts the report to a single branch's readiness — used when a branch-scoped viewer selects one branch, otherwise omitted for the org-wide view. */
  branchId?: string;
}

/**
 * CR-011.2 — read-only Recipe/BOM readiness report ahead of the CR-012
 * ProductComponent POS-deduction cutover. Advisory only: nothing here can
 * create/edit/delete a ProductComponent or touch POS deduction.
 */
export function RecipeReadinessReport({ branchId }: RecipeReadinessReportProps) {
  const [statusFilter, setStatusFilter] = useState<ReadinessStatus | 'ALL'>('ALL');

  const { data: report, isLoading, isError } = useRecipeReadiness({
    branchId,
    status: statusFilter === 'ALL' ? undefined : statusFilter,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !report) {
    return <p className="text-sm text-destructive">Failed to load the recipe readiness report.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Recipe Readiness</h1>
          <p className="text-sm text-muted-foreground">
            Generated {new Date(report.generated_at).toLocaleString()} — read-only, advisory ahead of CR-012.
          </p>
        </div>
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as ReadinessStatus | 'ALL')}>
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All statuses</SelectItem>
            {(Object.keys(STATUS_LABELS) as ReadinessStatus[]).map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Total Variants</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{report.summary.total_variants}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Ready</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-success">{report.summary.ready_count}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Blocked</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-destructive">{report.summary.blocked_count}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Readiness</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{report.summary.readiness_percentage}%</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Variants ({report.variants.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {report.variants.length === 0 ? (
            <p className="text-sm text-muted-foreground">No variants match the current filters.</p>
          ) : (
            report.variants.map((variant) => <VariantCard key={variant.product_variant_id} variant={variant} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
}
