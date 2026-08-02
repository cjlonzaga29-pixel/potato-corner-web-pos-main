import type { ProductReadinessResponse, ReadinessIssueResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReadinessStatusBadge } from './readiness-status-badge';

interface ReadinessChecklistProps {
  data: ProductReadinessResponse;
  onNavigateToTab: (tab: string) => void;
  /** When provided, the branch-availability quick-action calls this (e.g. to scroll/focus an inline section) instead of switching tabs. */
  onManageBranchAvailability?: () => void;
}

/**
 * Renders the blocking-issue / warning / variant-breakdown list for a single-branch
 * readiness result. Takes readiness data as a prop — it never fetches it itself, so it
 * can be reused anywhere the caller already has a ProductReadinessResponse in hand.
 */
export function ReadinessChecklist({ data, onNavigateToTab, onManageBranchAvailability }: ReadinessChecklistProps) {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => onNavigateToTab('variants')}>
          Manage Variants, Flavors, Inventory Mapping & Recipe/BOM
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => (onManageBranchAvailability ? onManageBranchAvailability() : onNavigateToTab('availability'))}
        >
          Manage Branch Availability
        </Button>
      </div>

      <IssueSection title="Blocking Issues" issues={data.blocking_issues} emptyLabel="No blocking issues." />
      <IssueSection title="Warnings" issues={data.warnings} emptyLabel="No warnings." />

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Variant Breakdown</h3>
        {data.variants.length === 0 ? (
          <p className="text-sm text-muted-foreground">No eligible (active) variants to evaluate at this branch.</p>
        ) : (
          data.variants.map((variant) => (
            <Card key={variant.product_variant_id}>
              <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 py-3">
                <CardTitle className="text-sm font-medium">{variant.variant_name}</CardTitle>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ReadinessStatusBadge status={variant.status} />
                  <span>{variant.completion_percentage}%</span>
                  <span>Recipe: {variant.recipe_ready ? 'Configured' : 'Missing'}</span>
                  <span>Inventory Mapping: {variant.inventory_mapping_ready ? 'Complete' : 'Incomplete'}</span>
                </div>
              </CardHeader>
              {(variant.blocking_issues.length > 0 || variant.warnings.length > 0) && (
                <CardContent className="space-y-2 py-0 pb-3">
                  <IssueSection title="Blocking Issues" issues={variant.blocking_issues} emptyLabel={null} compact />
                  <IssueSection title="Warnings" issues={variant.warnings} emptyLabel={null} compact />
                </CardContent>
              )}
            </Card>
          ))
        )}
      </div>
    </>
  );
}

function IssueSection({
  title,
  issues,
  emptyLabel,
  compact = false,
}: {
  title: string;
  issues: ReadinessIssueResponse[];
  emptyLabel: string | null;
  compact?: boolean;
}) {
  if (issues.length === 0) {
    return emptyLabel ? <p className="text-sm text-muted-foreground">{emptyLabel}</p> : null;
  }

  return (
    <div className="space-y-2">
      {!compact && <h3 className="text-sm font-semibold">{title}</h3>}
      <ul className="space-y-2">
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${index}`} className="rounded-md border p-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant={issue.severity === 'blocking' ? 'critical' : 'warning'}>{issue.severity}</Badge>
              <span className="font-medium">{issue.message}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Recommended action: {issue.recommended_action}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
