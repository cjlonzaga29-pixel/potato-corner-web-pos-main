'use client';

import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { BranchResponse } from '@potato-corner/shared';
import { BarChart3, Wifi, WifiOff, HelpCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/shared/data-table/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { formatCurrency } from '@/lib/utils';
import type { BranchPresenceResponse, BranchStatsOverview } from '@/hooks/queries/use-branches';

type Connectivity = 'online' | 'offline' | 'unknown';

export interface BranchPerformanceRow {
  branchId: string;
  name: string;
  code: string;
  status: BranchResponse['status'];
  connectivity: Connectivity;
  /** null when the branch has no live figures (only active branches are tracked by GET /branches/stats). */
  grossSales: number | null;
  transactionCount: number | null;
  averageOrderValue: number | null;
  activeShifts: number | null;
  staffClockedIn: number | null;
}

const CONNECTIVITY_LABEL: Record<Connectivity, string> = { online: 'Online', offline: 'Offline', unknown: 'Unknown' };

function ConnectivityBadge({ value }: { value: Connectivity }) {
  const Icon = value === 'online' ? Wifi : value === 'offline' ? WifiOff : HelpCircle;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      <Icon className={value === 'online' ? 'h-3.5 w-3.5 text-success' : 'h-3.5 w-3.5 text-muted-foreground'} aria-hidden="true" />
      {CONNECTIVITY_LABEL[value]}
    </span>
  );
}

function numeric(label: string) {
  return <div className="text-right">{label}</div>;
}

function cellNumber(value: number | null, format: (n: number) => string = String) {
  return <div className="text-right tabular-nums">{value === null ? '—' : format(value)}</div>;
}

const columns: ColumnDef<BranchPerformanceRow>[] = [
  {
    id: 'branch',
    header: 'Branch',
    cell: ({ row }) => (
      <div className="min-w-[10rem]">
        <p className="font-medium">{row.original.name}</p>
        <p className="font-mono text-xs text-muted-foreground">{row.original.code}</p>
      </div>
    ),
  },
  { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} type="branch" /> },
  { id: 'connectivity', header: 'Connection', cell: ({ row }) => <ConnectivityBadge value={row.original.connectivity} /> },
  { id: 'gross_sales', header: () => numeric('Gross Sales'), cell: ({ row }) => cellNumber(row.original.grossSales, formatCurrency) },
  { id: 'transactions', header: () => numeric('Transactions'), cell: ({ row }) => cellNumber(row.original.transactionCount) },
  { id: 'aov', header: () => numeric('Avg. Order'), cell: ({ row }) => cellNumber(row.original.averageOrderValue, formatCurrency) },
  { id: 'shifts', header: () => numeric('Active Shifts'), cell: ({ row }) => cellNumber(row.original.activeShifts) },
  { id: 'clocked_in', header: () => numeric('Clocked In'), cell: ({ row }) => cellNumber(row.original.staffClockedIn) },
];

/**
 * Pure join of the three sources, exported for tests. Every branch in
 * `branches` gets a row (so inactive/closed branches are visible with their
 * status), figures come from the same live per-branch stats the KPI row
 * sums, and connectivity comes from presence — never inferred from status.
 */
export function buildBranchPerformanceRows(
  branches: ReadonlyArray<Pick<BranchResponse, 'id' | 'name' | 'code' | 'status'>>,
  stats: ReadonlyArray<BranchStatsOverview>,
  presence: BranchPresenceResponse | undefined,
  branchId?: string,
): BranchPerformanceRow[] {
  const statsByBranch = new Map(stats.map((s) => [s.branchId, s]));
  const presenceByBranch = new Map<string, Connectivity>((presence?.available ? presence.branches : []).map((p) => [p.branch_id, p.connectivity]));
  return branches
    .filter((branch) => !branchId || branch.id === branchId)
    .map((branch) => {
      const s = statsByBranch.get(branch.id);
      return {
        branchId: branch.id,
        name: branch.name,
        code: branch.code,
        status: branch.status,
        connectivity: presenceByBranch.get(branch.id) ?? 'unknown',
        grossSales: s ? s.todayGrossSales : null,
        transactionCount: s ? s.todayTransactionCount : null,
        averageOrderValue: s ? (s.todayTransactionCount > 0 ? s.todayGrossSales / s.todayTransactionCount : 0) : null,
        activeShifts: s ? s.activeShiftsCount : null,
        staffClockedIn: s ? s.staffTimedInCount : null,
      };
    })
    .sort((a, b) => (b.grossSales ?? -1) - (a.grossSales ?? -1) || a.name.localeCompare(b.name));
}

interface DashboardBranchPerformanceTableProps {
  branches: ReadonlyArray<Pick<BranchResponse, 'id' | 'name' | 'code' | 'status'>>;
  stats: ReadonlyArray<BranchStatsOverview>;
  presence: BranchPresenceResponse | undefined;
  /** The dashboard's branch selector value; undefined = all branches. */
  branchId?: string;
  /** Selected branch's display name, for the scope line. */
  branchName?: string;
  /** Manila business date the figures cover (YYYY-MM-DD). */
  businessDate: string;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

/**
 * POS-PERF-P40 — replaces the BRANCH_COMPARISON snapshot this table used to
 * read. That snapshot covered a rolling 30 days and could be 15+ minutes
 * old, yet sat unlabeled next to "today" KPIs, so its Gross Sales and
 * Transactions never matched the cards above it. It now shows today's live
 * figures (Manila business day) from GET /branches/stats — the same rows the
 * KPI row sums — with the date and branch scope stated in the header.
 */
export function DashboardBranchPerformanceTable({
  branches,
  stats,
  presence,
  branchId,
  branchName,
  businessDate,
  isLoading,
  isError,
  onRetry,
}: DashboardBranchPerformanceTableProps) {
  const rows = useMemo(() => buildBranchPerformanceRows(branches, stats, presence, branchId), [branches, stats, presence, branchId]);
  const scope = branchId ? (branchName ?? 'Selected branch') : `All branches (${rows.length})`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <BarChart3 className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-sm font-medium">Branch Performance</CardTitle>
          <CardDescription className="text-xs">
            Today, {businessDate} (Manila) · {scope}. Gross sales are completed sales before discounts. Status is set by Admin;
            Connection shows whether anyone is signed in at the branch right now{presence && !presence.available ? ' (unavailable)' : ''}.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {isError ? (
          <ErrorState retry={onRetry} />
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            isLoading={isLoading}
            emptyState={<EmptyState title="No branches" description="Create a branch to see its performance here." />}
          />
        )}
        {!isLoading && !isError && rows.some((row) => row.grossSales === null) && (
          <p className="mt-2 text-xs text-muted-foreground">— Live figures are tracked for active branches only.</p>
        )}
      </CardContent>
    </Card>
  );
}
