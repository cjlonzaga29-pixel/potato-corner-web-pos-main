'use client';

import { useEffect, useRef } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { InventoryStockTransferResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';

export interface CompletedTransfer {
  result: InventoryStockTransferResponse;
  itemName: string;
  unit: string;
  fromName: string;
  toName: string;
  proofAttached: boolean;
}

interface TransferResultPanelProps {
  transfer: CompletedTransfer;
  onPrepareAnother: () => void;
  onDone: () => void;
}

/**
 * POS-PERF-P48 — shown once the API has answered 201. A transfer has no
 * approval step: both legs are already recorded, so the panel says
 * "completed" and shows the on-hand balances the two movements wrote.
 */
export function TransferResultPanel({ transfer, onPrepareAnother, onDone }: TransferResultPanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { result, itemName, unit, fromName, toName, proofAttached } = transfer;

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="mx-auto max-w-lg space-y-4" role="status">
      <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-950">
        <h1 ref={headingRef} tabIndex={-1} className="flex items-center gap-2 text-lg font-semibold focus:outline-none">
          <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
          Transfer completed
        </h1>
        <p className="mt-2">
          {result.quantity} {unit} of <span className="font-medium">{itemName}</span> moved from {fromName} to {toName}. Both legs were recorded together;
          there is no approval step for transfers.
        </p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 tabular-nums">
          <dt>{fromName} now has</dt>
          <dd>
            {result.transfer_out.quantity_after} {unit} on hand
          </dd>
          <dt>{toName} now has</dt>
          <dd>
            {result.transfer_in.quantity_after} {unit} on hand
          </dd>
          <dt>Proof photo</dt>
          <dd>{proofAttached ? 'Attached' : 'None'}</dd>
        </dl>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onDone}>
          Back to inventory
        </Button>
        <Button type="button" onClick={onPrepareAnother}>
          Prepare another transfer
        </Button>
      </div>
    </div>
  );
}
