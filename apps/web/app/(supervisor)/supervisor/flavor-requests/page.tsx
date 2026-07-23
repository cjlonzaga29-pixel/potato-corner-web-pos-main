'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import type { FlavorRequestResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { FlavorColorSwatch } from '@/components/admin/flavors/flavor-color-swatch';
import { formatDateTime } from '@/lib/utils';
import { useFlavorRequests, useFlavorRequestsRealtimeSync } from '@/hooks/queries/use-flavor-requests';

const STATUS_BADGE_VARIANT: Record<string, 'pending' | 'active' | 'critical'> = {
  pending: 'pending',
  approved: 'active',
  rejected: 'critical',
};

export default function SupervisorFlavorRequestsPage() {
  const router = useRouter();
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  useFlavorRequestsRealtimeSync();
  const { data, isLoading, isError, refetch } = useFlavorRequests({ page: pagination.pageIndex + 1, limit: pagination.pageSize });

  const columns: ColumnDef<FlavorRequestResponse>[] = [
    {
      id: 'proposed_name',
      header: 'Proposed Flavor',
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <FlavorColorSwatch colorHex={row.original.proposed_color_hex} />
          <span>{row.original.proposed_name}</span>
        </div>
      ),
    },
    { id: 'created_at', header: 'Submitted', cell: ({ row }) => formatDateTime(row.original.created_at) },
    { id: 'status', header: 'Status', cell: ({ row }) => <Badge variant={STATUS_BADGE_VARIANT[row.original.status]}>{row.original.status}</Badge> },
    {
      id: 'review_notes',
      header: 'Review Notes',
      cell: ({ row }) => row.original.review_notes ?? '—',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Flavor Requests</h1>
          <p className="text-sm text-muted-foreground">New flavors you&apos;ve proposed, pending Super Admin approval.</p>
        </div>
        <Button onClick={() => router.push('/supervisor/flavor-requests/new')}>
          <Plus className="mr-2 h-4 w-4" />
          Submit New Request
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={data?.requests ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        emptyState={<EmptyState title="No flavor requests yet" description="Submit a request to propose a new flavor." />}
      />
    </div>
  );
}
