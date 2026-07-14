'use client';

import { PESO_DENOMINATIONS } from '@potato-corner/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';

export type DenominationQuantities = Record<number, number>;

export function denominationTotal(quantities: DenominationQuantities): number {
  return PESO_DENOMINATIONS.reduce((sum, d) => sum + d * (quantities[d] ?? 0), 0);
}

/** Only non-zero rows are sent to the API — a drawer's denomination breakdown doesn't need to enumerate every peso value it happens to have none of. */
export function denominationEntries(quantities: DenominationQuantities): { denomination: number; quantity: number }[] {
  return PESO_DENOMINATIONS.filter((d) => (quantities[d] ?? 0) > 0).map((d) => ({ denomination: d, quantity: quantities[d] ?? 0 }));
}

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

interface DenominationTableProps {
  quantities: DenominationQuantities;
  onChange: (denomination: number, quantity: number) => void;
}

/** Shared by /shift/open and /shift/close — the architecture doc specifies the identical denomination breakdown form for both cash counts. */
export function DenominationTable({ quantities, onChange }: DenominationTableProps) {
  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Denomination</TableHead>
            <TableHead>Quantity</TableHead>
            <TableHead className="text-right">Subtotal</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {PESO_DENOMINATIONS.map((d) => {
            const quantity = quantities[d] ?? 0;
            return (
              <TableRow key={d}>
                <TableCell className="font-medium">{formatPeso(d)}</TableCell>
                <TableCell>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    value={quantity || ''}
                    onChange={(e) => onChange(d, Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                    className="w-24"
                    aria-label={`Quantity of ${formatPeso(d)} bills or coins`}
                  />
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatPeso(d * quantity)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <div className="flex justify-end border-t pt-3 text-sm font-semibold">
        Running Total:<span className="ml-2 tabular-nums">{formatPeso(denominationTotal(quantities))}</span>
      </div>
    </div>
  );
}
