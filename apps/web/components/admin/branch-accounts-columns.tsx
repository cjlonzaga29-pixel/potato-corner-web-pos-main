'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { EditBranchAccountDialog } from '@/components/admin/edit-branch-account-dialog';
import type { BranchAccountOverview } from '@/hooks/queries/use-branches';

function ActionsCell({ account }: { account: BranchAccountOverview }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
      {open && <EditBranchAccountDialog open={open} onOpenChange={setOpen} account={account} />}
    </>
  );
}

export function createBranchAccountsColumns(): ColumnDef<BranchAccountOverview>[] {
  return [
    {
      id: 'branch',
      header: 'Branch',
      cell: ({ row }) => (
        <div>
          <p className="font-medium">{row.original.branch_name}</p>
          <p className="text-xs text-muted-foreground">{row.original.branch_code}</p>
        </div>
      ),
    },
    { accessorKey: 'email', header: 'Email' },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => <ActionsCell account={row.original} />,
    },
  ];
}
