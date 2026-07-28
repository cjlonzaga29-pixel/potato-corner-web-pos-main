'use client';

import { useState } from 'react';
import type { ProductDetailResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import {
  useBranchProductAvailability,
  useBulkUpdateBranchProductAvailability,
  useUpdateBranchProductAvailability,
} from '@/hooks/queries/use-products';

export function BranchAvailabilityPanel({ product }: { product: ProductDetailResponse }) {
  const { data, isLoading, isError, refetch } = useBranchProductAvailability(product.id);
  const updateAvailability = useUpdateBranchProductAvailability(product.id);
  const bulkUpdate = useBulkUpdateBranchProductAvailability(product.id);
  const globallyLocked = product.status === 'discontinued' || product.status === 'archived';

  const [confirmAction, setConfirmAction] = useState<'enable' | 'disable' | null>(null);
  const [copyFromBranch, setCopyFromBranch] = useState('');

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }
  if (isError) return <ErrorState retry={() => void refetch()} />;
  if (!data || data.length === 0) {
    return <EmptyState title="No active branches" description="There are no active branches to configure yet." />;
  }

  async function handleCopyFromBranch(branchId: string) {
    setCopyFromBranch(branchId);
    const source = data?.find((row) => row.branch_id === branchId);
    if (!source) {
      setCopyFromBranch('');
      return;
    }
    try {
      await bulkUpdate.mutateAsync(
        (data ?? [])
          .filter((row) => row.branch_id !== branchId)
          .map((row) => ({ branch_id: row.branch_id, is_available: source.is_available })),
      );
    } finally {
      setCopyFromBranch('');
    }
  }

  return (
    <div className="space-y-3">
      {globallyLocked && (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          This product is globally {product.status_label.toLowerCase()} — branch availability cannot be re-enabled until it changes globally.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={globallyLocked}
          onClick={() => setConfirmAction('enable')}
        >
          Enable All
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setConfirmAction('disable')}>
          Disable All
        </Button>
        <Select value={copyFromBranch} onValueChange={(value) => void handleCopyFromBranch(value)} disabled={globallyLocked || data.length <= 1}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Copy from branch..." />
          </SelectTrigger>
          <SelectContent>
            {data.map((row) => (
              <SelectItem key={row.branch_id} value={row.branch_id}>
                {row.branch_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Branch Code</TableHead>
              <TableHead>Branch Name</TableHead>
              <TableHead>City</TableHead>
              <TableHead>Available</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.branch_id}>
                <TableCell className="font-mono text-xs">{row.branch_code}</TableCell>
                <TableCell>{row.branch_name}</TableCell>
                <TableCell>{row.city}</TableCell>
                <TableCell>
                  <Switch
                    checked={row.is_available}
                    disabled={globallyLocked && !row.is_available}
                    onCheckedChange={(checked) =>
                      void updateAvailability.mutateAsync({ branchId: row.branch_id, isAvailable: checked })
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={confirmAction === 'enable' ? 'Enable this product for all branches?' : 'Disable this product for all branches?'}
        description="This updates availability for every active branch at once."
        confirmLabel={confirmAction === 'enable' ? 'Enable All' : 'Disable All'}
        variant={confirmAction === 'disable' ? 'danger' : 'default'}
        onConfirm={async () => {
          try {
            await bulkUpdate.mutateAsync(
              data.map((row) => ({ branch_id: row.branch_id, is_available: confirmAction === 'enable' })),
            );
          } finally {
            setConfirmAction(null);
          }
        }}
      />
    </div>
  );
}
