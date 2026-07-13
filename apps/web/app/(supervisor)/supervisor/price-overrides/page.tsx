'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import type { PriceOverrideResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatCurrency } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { usePriceOverrides } from '@/hooks/queries/use-price-overrides';

const STATUS_BADGE_VARIANT: Record<string, 'pending' | 'active' | 'critical'> = {
  pending: 'pending',
  approved: 'active',
  rejected: 'critical',
};

export default function SupervisorPriceOverridesPage() {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const { data, isLoading, isError, refetch } = usePriceOverrides({
    branch_id: activeBranchId ?? undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<PriceOverrideResponse>[] = [
    { id: 'variant', header: 'Product Variant', cell: ({ row }) => `${row.original.product_name} (${row.original.variant_name})` },
    { id: 'master_price', header: 'Master Price', cell: ({ row }) => formatCurrency(row.original.master_price) },
    { id: 'requested_price', header: 'Requested Price', cell: ({ row }) => formatCurrency(row.original.requested_price) },
    { id: 'status', header: 'Status', cell: ({ row }) => <Badge variant={STATUS_BADGE_VARIANT[row.original.status]}>{row.original.status}</Badge> },
    { id: 'review_notes', header: 'Rejection Reason', cell: ({ row }) => (row.original.status === 'rejected' ? row.original.review_notes : '—') },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Price Overrides</h1>
          <p className="text-sm text-muted-foreground">Branch-specific price override requests you&apos;ve submitted.</p>
        </div>
        <Button onClick={() => router.push('/supervisor/price-overrides/new')}>
          <Plus className="mr-2 h-4 w-4" />
          Submit New Override
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={data?.overrides ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        emptyState={<EmptyState title="No price overrides yet" description="Submit a request to set a branch-specific price." />}
      />
    </div>
  );
}
