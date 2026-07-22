'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { ROLE_LABELS, type Role } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import type { BranchAccountOverview } from '@/hooks/queries/use-branches';

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
    {
      id: 'name',
      header: 'Name',
      cell: ({ row }) => `${row.original.first_name} ${row.original.last_name}`,
    },
    { accessorKey: 'email', header: 'Email' },
    {
      id: 'role',
      header: 'Role',
      cell: ({ row }) => <Badge variant="secondary">{ROLE_LABELS[row.original.role as Role]}</Badge>,
    },
  ];
}
