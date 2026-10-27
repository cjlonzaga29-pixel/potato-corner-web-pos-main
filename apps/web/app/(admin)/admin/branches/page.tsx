'use client';

import { Suspense, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import type { BranchResponse, BranchStatus } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusBadge } from '@/components/shared/status-badge';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useBranch, useBranchAccountsOverview, useBranches, useBranchRealtimeSync } from '@/hooks/queries/use-branches';
import { useAllSupervisors } from '@/hooks/queries/use-employees';
import { CreateBranchDialog } from '@/components/admin/branches/create-branch-dialog';
import { BranchManagePanel, isBranchManageTab, type BranchManageTab } from '@/components/admin/branches/branch-manage-panel';

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'closed', label: 'Closed' },
];

/**
 * POS-PERF-P40 — Branches and Branch Accounts combined into one screen.
 * The list stays compact (Branch | Status | Assigned Supervisors | Branch
 * Account | Manage); everything else happens in the Manage panel. The panel
 * is addressable as `?manage=<branchId>&tab=details|account|supervisors`, which
 * is also where the old /admin/branch-accounts URL and branch notifications
 * land.
 */
function BranchListPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState('');
  const [city, setCity] = useState('');
  const [status, setStatus] = useState('all');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const [createOpen, setCreateOpen] = useState(false);

  useBranchRealtimeSync();

  const manageId = searchParams.get('manage');
  const tabParam = searchParams.get('tab');
  const manageTab: BranchManageTab = isBranchManageTab(tabParam) ? tabParam : 'details';

  const { data, isLoading, isError, refetch } = useBranches({
    status: status === 'all' ? undefined : (status as BranchStatus),
    city: city || undefined,
    search: search || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });
  const accounts = useBranchAccountsOverview();
  const supervisors = useAllSupervisors();
  // The branch being managed may not be on the current page/filter — fetch it directly.
  const managedFromList = data?.branches.find((b) => b.id === manageId);
  const managedQuery = useBranch(manageId && !managedFromList ? manageId : null);
  const managedBranch = managedFromList ?? managedQuery.data ?? null;

  const accountsByBranch = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const account of accounts.data ?? []) map.set(account.branch_id, [...(map.get(account.branch_id) ?? []), account.email]);
    return map;
  }, [accounts.data]);

  // Only active supervisor accounts with an active assignment to the branch.
  const supervisorsByBranch = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const supervisor of supervisors.data ?? []) {
      if (!supervisor.is_active) continue;
      const name = `${supervisor.first_name} ${supervisor.last_name}`.trim();
      for (const assignment of supervisor.branch_assignments) map.set(assignment.branch_id, [...(map.get(assignment.branch_id) ?? []), name]);
    }
    return map;
  }, [supervisors.data]);

  function setManage(branchId: string | null, tab: BranchManageTab = 'details') {
    const params = new URLSearchParams(searchParams.toString());
    if (branchId) {
      params.set('manage', branchId);
      params.set('tab', tab);
    } else {
      params.delete('manage');
      params.delete('tab');
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const columns: ColumnDef<BranchResponse>[] = [
    {
      id: 'branch',
      header: 'Branch',
      cell: ({ row }) => (
        <div className="min-w-[9rem]">
          <p className="font-medium">{row.original.name}</p>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{row.original.code}</span> · {row.original.city}
          </p>
        </div>
      ),
    },
    { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} type="branch" /> },
    {
      id: 'supervisors',
      header: 'Assigned Supervisors',
      cell: ({ row }) => {
        if (supervisors.isLoading) return <span className="text-xs text-muted-foreground">Loading…</span>;
        if (supervisors.isError) return <span className="text-xs text-muted-foreground">{row.original.activeSupervisorCount} assigned</span>;
        const names = supervisorsByBranch.get(row.original.id) ?? [];
        if (names.length === 0) return <span className="text-xs text-muted-foreground">None</span>;
        return (
          <span className="block max-w-[14rem] truncate text-sm" title={names.join(', ')}>
            {names.slice(0, 2).join(', ')}
            {names.length > 2 ? ` +${names.length - 2}` : ''}
          </span>
        );
      },
    },
    {
      id: 'account',
      header: 'Branch Account',
      cell: ({ row }) => {
        if (accounts.isLoading) return <span className="text-xs text-muted-foreground">Loading…</span>;
        if (accounts.isError) return <span className="text-xs text-muted-foreground">Unavailable</span>;
        const emails = accountsByBranch.get(row.original.id) ?? [];
        if (emails.length === 0) return <span className="text-xs text-warning">Not set up</span>;
        return (
          <span className="block max-w-[14rem] truncate text-sm" title={emails.join(', ')}>
            {emails[0]}
            {emails.length > 1 ? ` +${emails.length - 1}` : ''}
          </span>
        );
      },
    },
    {
      id: 'manage',
      header: () => <span className="sr-only">Manage</span>,
      cell: ({ row }) => (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Manage ${row.original.name}`}
          onClick={(event) => {
            event.stopPropagation();
            setManage(row.original.id);
          }}
        >
          Manage
        </Button>
      ),
    },
  ];

  return (
    <div className="app-section app-section-gap">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="app-title font-bold">Branches</h1>
          <p className="text-sm text-muted-foreground">Branch details, login accounts and supervisor assignments.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" />
          Create Branch
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
          placeholder="Search name or code..."
          className="w-full sm:max-w-xs"
        />
        <Input
          placeholder="Filter by city"
          aria-label="Filter by city"
          value={city}
          onChange={(event) => {
            setCity(event.target.value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
          className="w-full sm:max-w-[180px]"
        />
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
          }}
        >
          <SelectTrigger className="w-full sm:w-[150px]" aria-label="Filter by status">
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

      <DataTable
        columns={columns}
        data={data?.branches ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(branch) => setManage(branch.id)}
        emptyState={<EmptyState title="No branches yet" description="Create your first branch to get started." />}
      />

      <CreateBranchDialog open={createOpen} onOpenChange={setCreateOpen} />
      {managedBranch && (
        <BranchManagePanel
          key={managedBranch.id}
          branch={managedBranch}
          tab={manageTab}
          onTabChange={(tab) => setManage(managedBranch.id, tab)}
          onOpenChange={(open) => !open && setManage(null)}
        />
      )}
    </div>
  );
}

export default function BranchListPage() {
  return (
    <Suspense fallback={<div>Loading branches...</div>}>
      <BranchListPageContent />
    </Suspense>
  );
}
