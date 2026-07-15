'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { BranchFlavorAvailabilityRow } from '@potato-corner/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useBranchFlavorAvailability, useUpdateBranchFlavorAvailability } from '@/hooks/queries/use-flavors';

interface BranchFlavorAvailabilityTableProps {
  flavorId: string;
}

function BranchFlavorRow({ row, flavorId }: { row: BranchFlavorAvailabilityRow; flavorId: string }) {
  const updateAvailability = useUpdateBranchFlavorAvailability(flavorId);
  const [isAvailable, setIsAvailable] = useState(row.is_available);
  const [reason, setReason] = useState(row.unavailable_reason ?? '');

  const isDirty = isAvailable !== row.is_available || (!isAvailable && reason !== (row.unavailable_reason ?? ''));

  async function handleSave() {
    await updateAvailability.mutateAsync({ branchId: row.branch_id, isAvailable, unavailableReason: isAvailable ? undefined : reason || undefined });
  }

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{row.branch_code}</TableCell>
      <TableCell>{row.branch_name}</TableCell>
      <TableCell>{row.city}</TableCell>
      <TableCell>
        <Switch checked={isAvailable} onCheckedChange={setIsAvailable} />
      </TableCell>
      <TableCell>
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={isAvailable}
          placeholder={isAvailable ? 'N/A' : 'Reason (optional)'}
          className="max-w-xs"
        />
      </TableCell>
      <TableCell>
        <Button size="sm" variant="outline" disabled={!isDirty || updateAvailability.isPending} onClick={() => void handleSave()}>
          {updateAvailability.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function BranchFlavorAvailabilityTable({ flavorId }: BranchFlavorAvailabilityTableProps) {
  const { data, isLoading, isError, refetch } = useBranchFlavorAvailability(flavorId);

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

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Code</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead>City</TableHead>
            <TableHead>Available</TableHead>
            <TableHead>Unavailable Reason</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => (
            <BranchFlavorRow key={row.branch_id} row={row} flavorId={flavorId} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
