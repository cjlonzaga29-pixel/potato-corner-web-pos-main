'use client';

import { Users } from 'lucide-react';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { createBranchAccountsColumns } from '@/components/admin/branch-accounts-columns';
import { useBranchAccountsOverview } from '@/hooks/queries/use-branches';

const columns = createBranchAccountsColumns();

export default function BranchAccountsPage() {
  const { data, isLoading, isError, refetch } = useBranchAccountsOverview();

  return (
    <div className="app-section app-section-gap">
      <div>
        <h1 className="app-title font-bold">Branch Accounts</h1>
        <p className="text-sm text-muted-foreground">Branch login accounts only — supervisors and staff are managed under Employees</p>
      </div>

      <DataTable
        columns={columns}
        data={data ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={<EmptyState icon={Users} title="No branch accounts found" description="No active assignments have been recorded yet." />}
      />
    </div>
  );
}
