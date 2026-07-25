'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { BranchResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useDeleteBranch } from '@/hooks/queries/use-branches';

interface DeleteBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: BranchResponse;
}

const DELETE_KEYWORD = 'DELETE';

/** Two-field confirmation (branch name + literal "DELETE") for the cascading hard-delete action. */
export function DeleteBranchDialog({ open, onOpenChange, branch }: DeleteBranchDialogProps) {
  const router = useRouter();
  const deleteBranch = useDeleteBranch(branch.id);
  const [confirmName, setConfirmName] = useState('');
  const [confirmKeyword, setConfirmKeyword] = useState('');

  const canDelete = confirmName.trim() === branch.name && confirmKeyword.trim() === DELETE_KEYWORD;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setConfirmName('');
      setConfirmKeyword('');
    }
    onOpenChange(next);
  }

  async function handleDelete() {
    await deleteBranch.mutateAsync();
    handleOpenChange(false);
    router.push('/admin/branches');
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Permanently delete this branch?</DialogTitle>
          <DialogDescription>
            This destroys all of this branch&apos;s transactions, shifts, inventory, expenses, and attendance
            records. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>There is no way to recover this branch or its data once deleted.</span>
        </div>

        <div className="space-y-2">
          <Label htmlFor="delete-confirm-name">
            Type <span className="font-semibold">{branch.name}</span> to confirm
          </Label>
          <Input
            id="delete-confirm-name"
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            placeholder={branch.name}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="delete-confirm-keyword">
            Type <span className="font-semibold">{DELETE_KEYWORD}</span> to confirm
          </Label>
          <Input
            id="delete-confirm-keyword"
            value={confirmKeyword}
            onChange={(event) => setConfirmKeyword(event.target.value)}
            placeholder={DELETE_KEYWORD}
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={!canDelete || deleteBranch.isPending}
            onClick={() => void handleDelete()}
          >
            {deleteBranch.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Permanently Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
