'use client';

import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { AuditLogResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { formatDateTime } from '@/lib/utils';

function AuditLogDetailsCell({ log }: { log: AuditLogResponse }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        View
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Audit Log Details</DialogTitle>
            <DialogDescription>
              {log.action} on {log.entity_type} {log.entity_id ?? ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-medium">Before</h3>
              <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(log.before_state, null, 2)}
              </pre>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-medium">After</h3>
              <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(log.after_state, null, 2)}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function createAuditLogColumns(): ColumnDef<AuditLogResponse>[] {
  return [
    {
      id: 'created_at',
      header: 'Date',
      cell: ({ row }) => formatDateTime(row.original.created_at),
    },
    {
      id: 'actor',
      header: 'Actor',
      cell: ({ row }) => {
        const actor = row.original.actor;
        if (!actor) return 'System';
        return `${actor.first_name} ${actor.last_name} (${actor.email})`;
      },
    },
    {
      id: 'branch',
      header: 'Branch',
      cell: ({ row }) => row.original.branch?.name ?? '—',
    },
    {
      id: 'action',
      header: 'Action',
      cell: ({ row }) => row.original.action,
    },
    {
      id: 'entity',
      header: 'Entity Type',
      cell: ({ row }) => `${row.original.entity_type} ${row.original.entity_id ?? ''}`.trim(),
    },
    {
      id: 'details',
      header: 'Details',
      enableSorting: false,
      enableHiding: false,
      cell: ({ row }) => <AuditLogDetailsCell log={row.original} />,
    },
  ];
}
