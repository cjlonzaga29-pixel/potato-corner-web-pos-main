'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type {
  ProductDetailResponse,
  ProductReadinessAllBranchesResponse,
  ProductReadinessResponse,
  ReadinessIssueResponse,
} from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { BranchSelector } from '@/components/admin/branch-selector';
import { useProductReadiness, usePublishProduct, useUnpublishProduct } from '@/hooks/queries/use-products';

interface ReadinessTabProps {
  product: ProductDetailResponse;
  selectedBranchId: string;
  onNavigateToTab: (tab: string) => void;
}

/**
 * Phase D1 — Admin Readiness panel. Every readiness number/issue here comes
 * straight from GET /:productId/readiness (productReadinessService) — this
 * component only renders it, it never recomputes readiness itself.
 */
export function ReadinessTab({ product, selectedBranchId, onNavigateToTab }: ReadinessTabProps) {
  const isAllBranches = selectedBranchId === 'all';
  const { data, isLoading, isError, refetch } = useProductReadiness(product.id, selectedBranchId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <BranchSelector />
        </div>
        {isAllBranches && (
          <p className="text-sm text-muted-foreground">All Branches is read-only — select a single branch to publish or unpublish.</p>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : isError || !data ? (
        <ErrorState title="Failed to load readiness" retry={() => void refetch()} />
      ) : data.scope === 'all_branches' ? (
        <AllBranchesSummary data={data} />
      ) : (
        <SingleBranchReadiness product={product} data={data} onNavigateToTab={onNavigateToTab} />
      )}
    </div>
  );
}

function AllBranchesSummary({ data }: { data: ProductReadinessAllBranchesResponse }) {
  if (data.branches.length === 0) {
    return <p className="text-sm text-muted-foreground">There are no active branches to show readiness for.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-2">Branch</th>
            <th className="px-4 py-2">Published</th>
            <th className="px-4 py-2">Readiness</th>
            <th className="px-4 py-2">Completion</th>
            <th className="px-4 py-2">Issues</th>
          </tr>
        </thead>
        <tbody>
          {data.branches.map((branch) => (
            <tr key={branch.branch_id} className="border-t">
              <td className="px-4 py-2 font-medium">{branch.branch_name}</td>
              <td className="px-4 py-2">
                <Badge variant={branch.is_published ? 'active' : 'inactive'}>{branch.is_published ? 'Published' : 'Unpublished'}</Badge>
              </td>
              <td className="px-4 py-2">
                <ReadinessStatusBadge status={branch.status} />
              </td>
              <td className="px-4 py-2">{branch.completion_percentage}%</td>
              <td className="px-4 py-2 text-muted-foreground">
                {branch.blocking_issue_count} blocking · {branch.warning_count} warning{branch.warning_count === 1 ? '' : 's'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReadinessStatusBadge({ status }: { status: 'READY' | 'NOT_READY' }) {
  if (status === 'READY') {
    return (
      <Badge variant="active" className="gap-1">
        <CheckCircle2 className="h-3 w-3" /> Ready
      </Badge>
    );
  }
  return (
    <Badge variant="critical" className="gap-1">
      <XCircle className="h-3 w-3" /> Not Ready
    </Badge>
  );
}

function SingleBranchReadiness({
  product,
  data,
  onNavigateToTab,
}: {
  product: ProductDetailResponse;
  data: ProductReadinessResponse;
  onNavigateToTab: (tab: string) => void;
}) {
  const publish = usePublishProduct(product.id);
  const unpublish = useUnpublishProduct(product.id);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const globallyLocked = product.status === 'discontinued' || product.status === 'archived';
  const branchRow = product.branch_availability.find((row) => row.branch_id === data.branch_id);
  const isPublished = branchRow?.is_available ?? false;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ReadinessStatusBadge status={data.status} />
              <span className="text-sm font-normal text-muted-foreground">{data.completion_percentage}% complete</span>
            </CardTitle>
            <CardDescription>
              {data.ready_variant_count} of {data.eligible_variant_count} eligible variant{data.eligible_variant_count === 1 ? '' : 's'} sellable at
              this branch ({data.variant_count} total variant{data.variant_count === 1 ? '' : 's'}).
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!isPublished || unpublish.isPending}
              onClick={() => setConfirmUnpublish(true)}
            >
              Unpublish
            </Button>
            <Button
              disabled={globallyLocked || !data.sellable || isPublished || publish.isPending}
              onClick={() => setConfirmPublish(true)}
            >
              Publish
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryStat label="Published" value={isPublished ? 'Yes' : 'No'} />
            <SummaryStat label="POS Sellable" value={data.sellable ? 'Yes' : 'No'} />
            <SummaryStat label="Blocking Issues" value={String(data.blocking_issues.length)} />
            <SummaryStat label="Warnings" value={String(data.warnings.length)} />
          </div>
          {globallyLocked && (
            <p className="text-destructive">
              This product is globally {product.status_label.toLowerCase()} — publishing is disabled until that changes.
            </p>
          )}
        </CardContent>
      </Card>

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Known limitations of this view</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            Publishing applies to the whole product at this branch — Branch Availability is product-level, so per-variant branch publishing is
            not supported yet.
          </p>
          <p>Flavor selection mode (fixed vs. customer-selected) cannot be distinguished by this system yet.</p>
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => onNavigateToTab('variants')}>
          Manage Variants, Flavors, Inventory Mapping & Recipe/BOM
        </Button>
        <Button variant="outline" size="sm" onClick={() => onNavigateToTab('availability')}>
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

      <details className="rounded-md border p-3 text-xs" open={showDiagnostics} onToggle={(e) => setShowDiagnostics(e.currentTarget.open)}>
        <summary className="cursor-pointer select-none font-medium text-muted-foreground">Developer diagnostics</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">{JSON.stringify(data, null, 2)}</pre>
      </details>

      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title={`Publish ${product.name} at this branch?`}
        description="This enables the product for sale at this branch (Branch Availability). It does not affect any other branch."
        confirmLabel="Publish"
        onConfirm={async () => {
          await publish.mutateAsync(data.branch_id);
        }}
      />
      <ConfirmDialog
        open={confirmUnpublish}
        onOpenChange={setConfirmUnpublish}
        title={`Unpublish ${product.name} at this branch?`}
        description="This disables the product for sale at this branch only. Variant, flavor, and inventory configuration are kept as-is."
        confirmLabel="Unpublish"
        variant="danger"
        onConfirm={async () => {
          await unpublish.mutateAsync(data.branch_id);
        }}
      />
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
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
