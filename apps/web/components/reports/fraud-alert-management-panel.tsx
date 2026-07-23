'use client';

import { Suspense, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import type { PaginationState } from '@tanstack/react-table';
import { ShieldAlert } from 'lucide-react';
import { FRAUD_ALERT_SEVERITY, FRAUD_ALERT_STATUS, type FraudAlertResponse } from '@potato-corner/shared';
import { KpiCard } from '@/components/shared/charts/kpi-card';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { createFraudAlertColumns } from '@/components/admin/fraud-alert-columns';
import { DismissFraudAlertDialog } from '@/components/admin/fraud-dismiss-dialog';
import { useFraudAlerts, useFraudAlertsRealtimeSync, useInvestigateAlert, useEscalateAlert } from '@/hooks/queries/use-fraud-alerts';
import { useBranches } from '@/hooks/queries/use-branches';

function humanize(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const STATUS_FILTERS = [
  { value: 'all', label: 'All Statuses' },
  ...Object.values(FRAUD_ALERT_STATUS).map((value) => ({ value, label: humanize(value) })),
] as const;

const SEVERITY_FILTERS = [
  { value: 'all', label: 'All Severities' },
  ...Object.values(FRAUD_ALERT_SEVERITY).map((value) => ({ value, label: humanize(value) })),
] as const;

const ALL_BRANCHES = 'all';
const DEFAULT_PAGE_SIZE = 25;

const STATUS_VALUES = new Set<string>(STATUS_FILTERS.map((f) => f.value));
const SEVERITY_VALUES = new Set<string>(SEVERITY_FILTERS.map((f) => f.value));

/** Narrows a raw URL param to a known status value, or 'all' — protects against a hand-edited/stale URL holding an unrecognized value. */
function toStatusFilter(value: string | null): (typeof STATUS_FILTERS)[number]['value'] {
  return value && STATUS_VALUES.has(value) ? (value as (typeof STATUS_FILTERS)[number]['value']) : 'all';
}

function toSeverityFilter(value: string | null): (typeof SEVERITY_FILTERS)[number]['value'] {
  return value && SEVERITY_VALUES.has(value) ? (value as (typeof SEVERITY_FILTERS)[number]['value']) : 'all';
}

function FraudAlertManagementPanelContent() {
  useFraudAlertsRealtimeSync();

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const status = toStatusFilter(searchParams.get('fraud_status'));
  const severity = toSeverityFilter(searchParams.get('fraud_severity'));
  const branchId = searchParams.get('fraud_branch_id') ?? ALL_BRANCHES;
  const page = Number(searchParams.get('fraud_page') ?? '1') || 1;
  const pageSize = Number(searchParams.get('fraud_limit') ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE;

  const pagination: PaginationState = { pageIndex: Math.max(page - 1, 0), pageSize };

  /** Pushes URL param updates (shallow, no scroll jump), namespaced with a `fraud_` prefix so this panel's filters don't collide with the parent Reports page's own `tab`/date-range params. */
  function pushParams(updates: Record<string, string | null>, resetPage: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === 'all') params.delete(key);
      else params.set(key, value);
    }
    if (resetPage) params.set('fraud_page', '1');
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const { data: branchesData, isLoading: isBranchesLoading } = useBranches({ limit: 100 });
  const { data, isLoading, isError, refetch } = useFraudAlerts({
    status: status === 'all' ? undefined : status,
    severity: severity === 'all' ? undefined : severity,
    branch_id: branchId === ALL_BRANCHES ? undefined : branchId,
    page,
    limit: pageSize,
  });

  const investigateAlert = useInvestigateAlert();
  const escalateAlert = useEscalateAlert();

  const [dismissTarget, setDismissTarget] = useState<FraudAlertResponse | null>(null);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [investigateTarget, setInvestigateTarget] = useState<FraudAlertResponse | null>(null);
  const [escalateTarget, setEscalateTarget] = useState<FraudAlertResponse | null>(null);

  const alerts = data?.alerts ?? [];
  const branches = branchesData?.branches ?? [];

  const pendingAlertId = investigateAlert.isPending
    ? (investigateAlert.variables?.id ?? null)
    : escalateAlert.isPending
      ? (escalateAlert.variables?.id ?? null)
      : null;

  const openCount = alerts.filter((alert) => alert.status === 'open').length;
  const investigatingCount = alerts.filter((alert) => alert.status === 'investigating').length;
  const escalatedCount = alerts.filter((alert) => alert.status === 'escalated').length;

  const hasActiveFilters = status !== 'all' || severity !== 'all' || branchId !== ALL_BRANCHES;

  function clearFilters() {
    router.push(pathname, { scroll: false });
  }

  const columns = createFraudAlertColumns({
    onInvestigate: (alert) => setInvestigateTarget(alert),
    onDismiss: (alert) => {
      setDismissTarget(alert);
      setDismissOpen(true);
    },
    onEscalate: (alert) => setEscalateTarget(alert),
    pendingAlertId,
  });

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">Alert Management</h3>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard title="Open Alerts" value={openCount} isLoading={isLoading} tone={openCount > 0 ? 'danger' : 'default'} />
        <KpiCard
          title="Under Investigation"
          value={investigatingCount}
          isLoading={isLoading}
          tone={investigatingCount > 0 ? 'warning' : 'default'}
        />
        <KpiCard title="Escalated" value={escalatedCount} isLoading={isLoading} tone={escalatedCount > 0 ? 'danger' : 'default'} />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="fraud-status-filter">Status</Label>
          <Select value={status} onValueChange={(value) => pushParams({ fraud_status: value }, true)}>
            <SelectTrigger id="fraud-status-filter" className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((filter) => (
                <SelectItem key={filter.value} value={filter.value}>
                  {filter.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="fraud-severity-filter">Severity</Label>
          <Select value={severity} onValueChange={(value) => pushParams({ fraud_severity: value }, true)}>
            <SelectTrigger id="fraud-severity-filter" className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEVERITY_FILTERS.map((filter) => (
                <SelectItem key={filter.value} value={filter.value}>
                  {filter.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="fraud-branch-filter">Branch</Label>
          <Select value={branchId} onValueChange={(value) => pushParams({ fraud_branch_id: value }, true)}>
            <SelectTrigger id="fraud-branch-filter" className="w-[220px]" disabled={isBranchesLoading}>
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
      </div>

      <DataTable
        columns={columns}
        data={alerts}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={(next) =>
          pushParams({ fraud_page: String(next.pageIndex + 1), fraud_limit: String(next.pageSize) }, false)
        }
        rowCount={data?.total ?? 0}
        emptyState={
          hasActiveFilters ? (
            <EmptyState
              icon={ShieldAlert}
              title="No alerts match the current filters"
              description="Try a different status, severity, or branch."
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState icon={ShieldAlert} title="No fraud alerts found" description="No fraud alerts have been raised yet." />
          )
        }
      />

      <DismissFraudAlertDialog
        alert={dismissTarget}
        open={dismissOpen}
        onOpenChange={(open) => {
          setDismissOpen(open);
          if (!open) setDismissTarget(null);
        }}
      />

      <ConfirmDialog
        open={investigateTarget !== null}
        onOpenChange={(open) => !open && setInvestigateTarget(null)}
        title="Start investigation?"
        description={investigateTarget ? `Mark "${investigateTarget.alert_type}" as under investigation.` : undefined}
        confirmLabel="Confirm Investigation"
        onConfirm={async () => {
          if (investigateTarget) await investigateAlert.mutateAsync({ id: investigateTarget.id });
        }}
      />

      <ConfirmDialog
        open={escalateTarget !== null}
        onOpenChange={(open) => !open && setEscalateTarget(null)}
        title="Escalate this alert?"
        description={escalateTarget ? `Escalate "${escalateTarget.alert_type}" for urgent review.` : undefined}
        confirmLabel="Confirm Escalation"
        variant="danger"
        onConfirm={async () => {
          if (escalateTarget) await escalateAlert.mutateAsync({ id: escalateTarget.id });
        }}
      />
    </div>
  );
}

export function FraudAlertManagementPanel() {
  return (
    <Suspense fallback={<div>Loading alert management...</div>}>
      <FraudAlertManagementPanelContent />
    </Suspense>
  );
}
