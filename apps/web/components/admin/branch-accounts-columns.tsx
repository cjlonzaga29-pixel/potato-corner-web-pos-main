'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { ResetBranchPasswordDialog } from '@/components/admin/reset-branch-password-dialog';
import type { BranchAccountOverview } from '@/hooks/queries/use-branches';

function PasswordCell({ account }: { account: BranchAccountOverview }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <p className="font-mono text-sm text-muted-foreground">••••••••</p>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Reset Password
      </Button>
      {open && <ResetBranchPasswordDialog open={open} onOpenChange={setOpen} account={account} />}
    </div>
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
      id: 'password',
      header: 'Password',
      cell: ({ row }) => <PasswordCell account={row.original} />,
    },
  ];
}
