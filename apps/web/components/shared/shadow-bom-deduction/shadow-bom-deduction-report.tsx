'use client';

import { Suspense, useState } from 'react';
import type { PaginationState } from '@tanstack/react-table';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { GitCompare } from 'lucide-react';
import type { ShadowBomClassificationValue } from '@potato-corner/shared';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { shadowBomDeductionColumns, classificationLabel } from '@/components/admin/shadow-bom-deduction-columns';
import { useShadowBomDeductionSummary, useShadowBomDeductionDetails } from '@/hooks/queries/use-shadow-bom-deduction';
import { useBranches } from '@/hooks/queries/use-branches';

const ALL_BRANCHES = 'all';
const ALL_CLASSIFICATIONS = 'all';
const DEFAULT_PAGE_SIZE = 25;

const CLASSIFICATION_OPTIONS: ShadowBomClassificationValue[] = [
  'MATCH',
  'BOM_NOT_READY',
  'MISSING_LEGACY_MAPPING',
  'MISSING_BOM_COMPONENT',
  'EXTRA_BOM_COMPONENT',
  'QUANTITY_MISMATCH',
  'UNIT_CONVERSION_UNSUPPORTED',
  'FLAVOR_DEPENDENCY',
  'ERROR',
];

/** Narrows a raw URL param to a known classification value, or 'all' — protects against a hand-edited/stale URL holding an unrecognized value. */
function toClassificationFilter(value: string | null): ShadowBomClassificationValue | typeof ALL_CLASSIFICATIONS {
  return value && CLASSIFICATION_OPTIONS.includes(value as ShadowBomClassificationValue)
    ? (value as ShadowBomClassificationValue)
    : ALL_CLASSIFICATIONS;
}

function ShadowBomDeductionReportContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const since = searchParams.get('shadow_since') ?? '';
  const until = searchParams.get('shadow_until') ?? '';
  const branchId = searchParams.get('shadow_branch_id') ?? ALL_BRANCHES;
  const productVariantId = searchParams.get('shadow_product_variant_id') ?? '';
  const classification = toClassificationFilter(searchParams.get('shadow_classification'));
  const page = Number(searchParams.get('shadow_page') ?? '1') || 1;
  const pageSize = Number(searchParams.get('shadow_page_size') ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE;

  const pagination: PaginationState = { pageIndex: Math.max(page - 1, 0), pageSize };
  const [productVariantInput, setProductVariantInput] = useState(productVariantId);

  /** Pushes URL param updates (shallow, no scroll jump), namespaced with a `shadow_` prefix so this panel's filters don't collide with any host page's own params. */
  function pushParams(updates: Record<string, string | null>, resetPage: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === 'all' || value === '') params.delete(key);
      else params.set(key, value);
    }
    if (resetPage) params.set('shadow_page', '1');
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const filters = {
    // Send the bare Manila business date as-is — the API resolves it to that
    // day's Manila start/end. `new Date(since).toISOString()` would parse it
    // as UTC midnight (Manila 8:00 AM), shifting the filter window by 8h.
    since: since || undefined,
    until: until || undefined,
    branchId: branchId === ALL_BRANCHES ? undefined : branchId,
    productVariantId: productVariantId || undefined,
    classification: classification === ALL_CLASSIFICATIONS ? undefined : classification,
  };

  const { data: branchesData, isLoading: isBranchesLoading } = useBranches({ limit: 100 });
  const branches = branchesData?.branches ?? [];

  const { data: summary, isLoading: isSummaryLoading, isError: isSummaryError, refetch: refetchSummary } =
    useShadowBomDeductionSummary(filters);
  const {
    data: details,
    isLoading: isDetailsLoading,
    isError: isDetailsError,
    refetch: refetchDetails,
  } = useShadowBomDeductionDetails({ ...filters, page, pageSize });

  const rows = details?.rows ?? [];
  const hasActiveFilters = Boolean(since || until || branchId !== ALL_BRANCHES || productVariantId || classification !== ALL_CLASSIFICATIONS);

  function clearFilters() {
    setProductVariantInput('');
    router.push(pathname, { scroll: false });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Shadow BOM Deduction</h1>
        <p className="text-sm text-muted-foreground">
          Read-only comparison of the legacy deduction against the future BOM/ProductComponent deduction. Advisory
          only — legacy deduction remains authoritative and nothing here writes inventory.
        </p>
      </div>

      {isSummaryError ? (
        <Card>
          <CardContent className="py-8">
            <p className="text-sm text-destructive">Failed to load the summary.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetchSummary()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard title="Total Compared" value={summary?.total_compared ?? 0} isLoading={isSummaryLoading} />
          <KpiCard title="Match Count" value={summary?.match_count ?? 0} isLoading={isSummaryLoading} tone="positive" />
          <KpiCard title="Match %" value={summary?.match_percentage ?? 0} suffix="%" isLoading={isSummaryLoading} />
          <KpiCard
            title="BOM Not Ready"
            value={summary?.counts_by_classification.BOM_NOT_READY ?? 0}
            isLoading={isSummaryLoading}
          />
          <KpiCard
            title="Total Mismatches"
            value={
              summary
                ? summary.total_compared -
                  summary.match_count -
                  (summary.counts_by_classification.BOM_NOT_READY ?? 0) -
                  (summary.counts_by_classification.ERROR ?? 0)
                : 0
            }
            isLoading={isSummaryLoading}
            tone="warning"
          />
          <KpiCard title="Errors" value={summary?.counts_by_classification.ERROR ?? 0} isLoading={isSummaryLoading} tone="danger" />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="shadow-date-from-filter">Date From</Label>
            <Input
              id="shadow-date-from-filter"
              type="date"
              className="w-[170px]"
              value={since}
              onChange={(e) => pushParams({ shadow_since: e.target.value || null }, true)}
            />
          </div>

          <div>
            <Label htmlFor="shadow-date-to-filter">Date To</Label>
            <Input
              id="shadow-date-to-filter"
              type="date"
              className="w-[170px]"
              value={until}
              onChange={(e) => pushParams({ shadow_until: e.target.value || null }, true)}
            />
          </div>

          <div>
            <Label htmlFor="shadow-branch-filter">Branch</Label>
            <Select value={branchId} onValueChange={(value) => pushParams({ shadow_branch_id: value }, true)}>
              <SelectTrigger id="shadow-branch-filter" className="w-[200px]" disabled={isBranchesLoading}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_BRANCHES}>All branches</SelectItem>
                {branches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="shadow-product-variant-filter">Product Variant ID</Label>
            <Input
              id="shadow-product-variant-filter"
              className="w-[220px]"
              placeholder="variant UUID"
              value={productVariantInput}
              onChange={(e) => setProductVariantInput(e.target.value)}
              onBlur={() => pushParams({ shadow_product_variant_id: productVariantInput || null }, true)}
            />
          </div>

          <div>
            <Label htmlFor="shadow-classification-filter">Classification</Label>
            <Select value={classification} onValueChange={(value) => pushParams({ shadow_classification: value }, true)}>
              <SelectTrigger id="shadow-classification-filter" className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CLASSIFICATIONS}>All classifications</SelectItem>
                {CLASSIFICATION_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {classificationLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {hasActiveFilters && (
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </CardContent>
      </Card>

      <DataTable
        columns={shadowBomDeductionColumns}
        data={rows}
        isLoading={isDetailsLoading}
        isError={isDetailsError}
        onRetry={() => void refetchDetails()}
        pagination={pagination}
        onPaginationChange={(next) =>
          pushParams({ shadow_page: String(next.pageIndex + 1), shadow_page_size: String(next.pageSize) }, false)
        }
        rowCount={details?.total ?? 0}
        emptyState={
          hasActiveFilters ? (
            <EmptyState
              icon={GitCompare}
              title="No comparisons match the current filters"
              description="Try a different date range, branch, product variant, or classification."
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState icon={GitCompare} title="No shadow comparisons yet" description="Comparisons appear here once sales are processed for an enabled branch." />
          )
        }
      />
    </div>
  );
}

/**
 * CR-012.1A — read-only Shadow BOM Deduction dashboard for Super Admin.
 * Advisory only: nothing here can rerun, edit, delete, or override a
 * comparison, and nothing here affects POS deduction, inventory, or sales
 * totals in any way.
 */
export function ShadowBomDeductionReport() {
  return (
    <Suspense fallback={<div>Loading shadow BOM deduction dashboard...</div>}>
      <ShadowBomDeductionReportContent />
    </Suspense>
  );
}
