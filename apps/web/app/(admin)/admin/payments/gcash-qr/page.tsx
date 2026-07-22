'use client';

import { Suspense, useState } from 'react';
import { Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { GcashQrUploader } from '@/components/payments/gcash-qr-uploader';
import { BranchMultiSelect } from '@/components/payments/branch-multi-select';
import { BulkAssignResult } from '@/components/payments/bulk-assign-result';
import { useBranches, useBulkAssignGcashQr, type BulkAssignGcashQrResult } from '@/hooks/queries/use-branches';

function GcashQrBulkAssignPageContent() {
  const { data, isLoading, isError, refetch } = useBranches({ limit: 100 });
  const bulkAssign = useBulkAssignGcashQr();

  const [file, setFile] = useState<File | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<BulkAssignGcashQrResult | null>(null);

  const branches = data?.branches ?? [];
  const canAssign = Boolean(file) && selectedIds.length > 0;

  function branchName(branchId: string): string {
    const branch = branches.find((b) => b.id === branchId);
    return branch ? `${branch.name} (${branch.code})` : branchId;
  }

  async function handleConfirmAssign() {
    if (!file) return;
    const assignResult = await bulkAssign.mutateAsync({ file, branchIds: selectedIds });
    setResult(assignResult);
    setConfirmOpen(false);
    setFile(null);
    setSelectedIds([]);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Bulk Assign GCash QR</h1>
        <p className="text-sm text-muted-foreground">
          Upload one GCash QR image and assign it to multiple branches at once.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. QR Image</CardTitle>
          <CardDescription>JPEG, PNG, or WebP, up to 5MB.</CardDescription>
        </CardHeader>
        <CardContent>
          <GcashQrUploader file={file} onFileChange={setFile} disabled={bulkAssign.isPending} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Branches</CardTitle>
          <CardDescription>Select every branch that should display this QR code.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-9 w-full" />
              ))}
            </div>
          ) : isError ? (
            <ErrorState retry={() => void refetch()} />
          ) : branches.length === 0 ? (
            <EmptyState title="No branches available" description="Create a branch before assigning a GCash QR." />
          ) : (
            <BranchMultiSelect
              branches={branches}
              selectedIds={selectedIds}
              onChange={setSelectedIds}
              search={search}
              onSearchChange={setSearch}
              disabled={bulkAssign.isPending}
            />
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button disabled={!canAssign || bulkAssign.isPending} onClick={() => setConfirmOpen(true)}>
          <Wallet className="mr-2 h-4 w-4" />
          Assign to {selectedIds.length || 0} branch{selectedIds.length === 1 ? '' : 'es'}
        </Button>
      </div>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Result</CardTitle>
          </CardHeader>
          <CardContent>
            <BulkAssignResult result={result} branchName={branchName} />
          </CardContent>
        </Card>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign GCash QR to {selectedIds.length} branch{selectedIds.length === 1 ? '' : 'es'}?</DialogTitle>
            <DialogDescription>
              This replaces the current GCash QR code shown to customers at each selected branch.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={bulkAssign.isPending}>
              Cancel
            </Button>
            <Button onClick={() => void handleConfirmAssign()} disabled={bulkAssign.isPending}>
              {bulkAssign.isPending ? 'Assigning...' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function GcashQrBulkAssignPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <GcashQrBulkAssignPageContent />
    </Suspense>
  );
}
